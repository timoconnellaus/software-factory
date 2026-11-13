// Planning, the loop (spec 20, ADR 0300, 0350): the planning session's operations. The Workflow
// starts, rounds, notes and ends a session; the planning agent (a runner job) revises the spec,
// chats, reads news, waits, yields and asks for the gate; people chat, report presence, read the
// planning view and move a session to another runner. Questions are in ./questions.ts.
import { json, parseJson } from "@software-factory/db";
import {
  chatReplyInputSchema,
  droppedEdits,
  type EditFootprint,
  editFootprint,
  mentions,
  PLANNING_INTERRUPT_LINES,
  pinSchema,
  planningNewsInputSchema,
  planningPeekInputSchema,
  planningReadyInputSchema,
  planningWaitInputSchema,
  rekeyFootprint,
  sameFootprint,
  specChildSchema,
  specReviseInputSchema,
  structureMoves,
  whyNotKept,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { kimConflicts } from "../kim.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  batchDue,
  type Delivered,
  enqueuePlanningJob,
  guardCurrentSpec,
  guardNoUnreadPersonNews,
  hasUnreadPersonNews,
  interruptPlanning,
  logPlanning,
  NEWS_EVENTS,
  newsEnvelope,
  OPEN_SESSION,
  openSession,
  type PlanningSessionRow,
  planningPrompt,
  planningReadyEvent,
  presentPeople,
  readNews,
  STANDING_EDITS_MAX,
  standingEdits,
  takeBackFromGate,
  wakeSession,
  withdrawSpecGate,
} from "../planning.ts";
import { liveArtifact } from "../planning-visuals.ts";
import { approverIds } from "../scope.ts";
<<<<<<< HEAD
import { childrenOf } from "../splits.ts";
=======
import { has } from "../workflow-features.ts";
>>>>>>> timoconnellaus/planning-splits
import { ACTIVE_RUN } from "./runners.ts";
import { fencingToken, jobId, requireWorkItem, workItemId } from "./shared.ts";
import { RUNNER_OFFLINE_MS } from "./work-items.ts";

/** The fields a planning job's calls carry: the relay adds them (ADR 0350). */
export const planningJobFields = {
  jobId,
  fencingToken,
  /** Optional: a call naming another work item than its job's is refused (`forbidden`). */
  workItemId: workItemId.optional(),
};
/** Planning job calls are scoped by their job, never by a work item they name. */
export const byJob = async (input: { jobId: string }) => ({ jobId: input.jobId });

/**
 * A planning job's call (ADR 0350): the job is this runner's, its run is active and holds the
 * work item's lease with this fencing token, and its session is open. Anything else is `fenced`
 * (the session yielded, ended, moved or the lease was lost); another work item is `forbidden`.
 */
export async function planningJob(
  ctx: HandlerContext,
  input: { jobId: string; fencingToken: number; workItemId?: string | undefined },
): Promise<{ session: PlanningSessionRow; runId: string }> {
  const w = requireWorkItem(ctx);
  if (ctx.actor.type !== "runner") {
    throw new OperationError("forbidden", "only a planning job's runner calls this");
  }
  if (input.workItemId && input.workItemId !== w.id) {
    throw new OperationError("forbidden", "a planning job may act only on its own work item");
  }
  const run = await ctx.db
    .selectFrom("core_runs")
    .select(["id", "runner_id", "status", "stage"])
    .where("job_id", "=", input.jobId)
    .executeTakeFirst();
  if (!run || run.runner_id !== ctx.actor.id) {
    throw new OperationError("forbidden", "this job belongs to another runner");
  }
  if (run.stage !== "planning") {
    throw new OperationError("forbidden", "only a planning job may call planning operations");
  }
  const lease = await ctx.db
    .selectFrom("core_leases")
    .select(["fencing_token", "holder_id"])
    .where("work_item_id", "=", w.id)
    .executeTakeFirst();
  if (
    !(ACTIVE_RUN as readonly string[]).includes(run.status) ||
    !lease ||
    lease.holder_id !== run.id ||
    lease.fencing_token !== input.fencingToken
  ) {
    throw new OperationError("fenced", `the job's lease is gone (run ${run.status})`, {
      fencingToken: input.fencingToken,
      current: lease?.fencing_token ?? null,
    });
  }
  const session = await ctx.db
    .selectFrom("core_planning_sessions")
    .selectAll()
    .where("current_job_id", "=", input.jobId)
    .where("status", "in", OPEN_SESSION as PlanningSessionRow["status"][])
    .executeTakeFirst();
  if (!session) throw new OperationError("fenced", "this job's planning session is over");
  return { session, runId: run.id };
}

/** Away notices for questions and replies go at most this often (one per burst). */
const NOTIFY_BURST_MS = 2 * 60_000;

/** How stale `agent_seen_at` may get before a look with nothing new writes it again. */
const SEEN_REFRESH_MS = 30_000;

/** The session is alive and doing something: the pill shows it. Writes only what changed. */
function markWorking(ctx: HandlerContext, session: PlanningSessionRow, activity?: string) {
  const status = session.status === "yielding" ? "yielding" : "working";
  const unchanged =
    session.status === status &&
    session.idle_since === null &&
    (activity === undefined || activity === session.activity) &&
    session.agent_seen_at !== null &&
    Date.parse(ctx.now) - Date.parse(session.agent_seen_at) < SEEN_REFRESH_MS;
  if (unchanged) return;
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({
        status,
        idle_since: null,
        agent_seen_at: ctx.now,
        updated_at: ctx.now,
        ...(activity !== undefined ? { activity } : {}),
      })
      .where("id", "=", session.id),
  );
  if (session.status !== "working") {
    logPlanning(ctx, session.work_item_id, "session.changed", { status: "working" });
  }
}

/** Whether the current spec is the planning agent's (not triage's first draft). */
async function agentDrafted(ctx: HandlerContext): Promise<boolean> {
  const w = requireWorkItem(ctx);
  if (!w.current_spec_id) return false;
  const spec = await ctx.db
    .selectFrom("core_specs")
    .select("created_by")
    .where("id", "=", w.current_spec_id)
    .executeTakeFirst();
  return spec?.created_by === ctx.actor.id;
}

/**
 * After planning was announced, a question the agent asks or a reply it sends tells the owner, once
 * per call, when nobody has the Planning view open (spec 26; kim notifies per burst).
 */
export async function notifyAway(
  ctx: HandlerContext,
  session: PlanningSessionRow,
  event: "planning.question" | "planning.reply",
  title: string,
) {
  if (!session.announced_at) return;
  // Once per burst (kim's push settle): nothing more for two minutes after a notice.
  if (
    session.notified_at &&
    Date.parse(ctx.now) - Date.parse(session.notified_at) < NOTIFY_BURST_MS
  ) {
    return;
  }
  const w = requireWorkItem(ctx);
  if ((await presentPeople(ctx, w.id)).length) return;
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({ notified_at: ctx.now })
      .where("id", "=", session.id),
  );
  const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
  const to = approvers.includes(w.requester_user_id) ? w.requester_user_id : (approvers[0] ?? null);
  ctx.emit({
    kind: "notify",
    payload: { event, userId: to, workItemId: w.id, title, url: `/work/${w.id}?tab=planning` },
  });
}

/** First draft + questions are in and the agent is waiting: tell the owner once (criterion 1). */
async function announce(ctx: HandlerContext, session: PlanningSessionRow) {
  if (session.announced_at) return;
  const w = requireWorkItem(ctx);
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({ announced_at: ctx.now })
      .where("id", "=", session.id)
      .where("announced_at", "is", null),
  );
  const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
  const to = approvers.includes(w.requester_user_id) ? w.requester_user_id : (approvers[0] ?? null);
  ctx.emit({
    kind: "notify",
    payload: {
      event: "planning.ready",
      userId: to,
      workItemId: w.id,
      title: `Planning is ready for #${w.number}: ${w.title}`,
      url: `/work/${w.id}?tab=planning`,
    },
  });
}

// ---- the Workflow's side ----

export const planningStart = defineOperation({
  name: "planning.start",
  description:
    "Start the work item's planning session (spec 20): a long-lived planning job in the light pool that drafts the spec and asks the first questions on its own. Idempotent: an open session is returned as is.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ sessionId: z.string(), round: z.number(), jobId: z.string().nullable() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const open = await openSession(ctx, w.id);
    if (open) return { sessionId: open.id, round: open.round, jobId: open.current_job_id };
    const session = {
      id: newId("planningSession"),
      session_ref: crypto.randomUUID(),
      runner_id: null,
    };
    const jobIdValue = enqueuePlanningJob(ctx, w, session, {
      resume: false,
      prompt: await planningPrompt(ctx, w),
    });
    ctx.write(
      ctx.db.insertInto("core_planning_sessions").values({
        id: session.id,
        work_item_id: w.id,
        session_ref: session.session_ref,
        status: "starting",
        current_job_id: jobIdValue,
        round: 1,
        created_by: ctx.actor.id,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    logPlanning(ctx, w.id, "session.changed", { status: "starting", sessionId: session.id });
    ctx.change({ entity: "planning_session", id: session.id, after: { jobId: jobIdValue } });
    return { sessionId: session.id, round: 1, jobId: jobIdValue };
  },
});

export const planningAwaitReady = defineOperation({
  name: "planning.awaitReady",
  description:
    "Where the planning session's round stands: whether the agent has asked for the spec gate (and with which spec), and the event (`planning-ready-<item>-<round>`) planning.ready sends.",
  risk: "read",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({
    round: z.number(),
    ready: z.boolean(),
    specId: z.string().nullable(),
    event: z.string(),
    sessionId: z.string().nullable(),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    return {
      round: session.round,
      ready: session.ready_spec_id !== null,
      specId: session.ready_spec_id,
      event: planningReadyEvent(w.id, session.round),
      sessionId: session.id,
    };
  },
});

export const planningNote = defineOperation({
  name: "planning.note",
  description:
    "The approver asked for changes at the spec gate: their note goes into the same planning session as a chat message from them (spec 20, criterion 10), the round moves on, and a yielded session resumes.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    note: z.string().max(20_000).nullable(),
    by: z.string().min(1),
  }),
  output: z.object({ round: z.number(), messageId: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    const messageId = newId("planningMessage");
    ctx.write(
      ctx.db.insertInto("core_planning_messages").values({
        id: messageId,
        work_item_id: w.id,
        author_kind: "person",
        author_id: input.by,
        text: input.note?.trim() || "Changes requested at the spec gate (no note).",
        kind: "gate",
        created_at: ctx.now,
      }),
    );
    const round = session.round + 1;
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({
          round,
          ready_spec_id: null,
          ready_at: null,
          at_gate: 0,
          // Changes requested turn "finish alone" off (ADR 0470): the approver wants a say.
          finish_alone_by: null,
          finish_alone_at: null,
          updated_at: ctx.now,
        })
        .where("id", "=", session.id),
    );
    if (session.finish_alone_by) {
      logPlanning(ctx, w.id, "finish.alone", { on: false, reason: "changes requested" });
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ status: "running", updated_at: ctx.now })
        .where("id", "=", w.id)
        .where("status", "=", "waiting"),
    );
    logPlanning(ctx, w.id, "chat.message", { messageId, kind: "gate" });
    await wakeSession(ctx, w);
    return { round, messageId };
  },
});

export const planningEnd = defineOperation({
  name: "planning.end",
  description:
    "The spec gate was decided: end the planning session and stop its run, so its light slot comes free (spec 20, criterion 10). Idempotent.",
  risk: "write",
  actors: ["agent", "human"],
  permission: "approver",
  input: z.object({ workItemId, reason: z.string().max(500) }),
  output: z.object({ ended: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) return { ended: false };
    await stopSession(ctx, session, "ended", input.reason);
    return { ended: true };
  },
});

/**
 * Ends a session (`ended` or `moved`) and stops its job: a queued one is cancelled; a running one's
 * run is cancelled and its lease released with the fencing token bumped, so the harness's next call
 * is `fenced` and the heartbeat tells the host to stop (ADR 0035).
 */
async function stopSession(
  ctx: HandlerContext,
  session: PlanningSessionRow,
  status: "ended" | "moved",
  reason: string,
) {
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({
        status,
        current_job_id: null,
        ended_at: ctx.now,
        end_reason: reason,
        idle_since: null,
        updated_at: ctx.now,
      })
      .where("id", "=", session.id),
  );
  if (session.current_job_id) {
    const job = await ctx.db
      .selectFrom("core_jobs")
      .select(["id", "status", "run_id"])
      .where("id", "=", session.current_job_id)
      .executeTakeFirst();
    if (job?.status === "queued") {
      ctx.write(
        ctx.db
          .updateTable("core_jobs")
          .set({ status: "cancelled", finished_at: ctx.now })
          .where("id", "=", job.id)
          .where("status", "=", "queued"),
      );
    } else if (job?.status === "claimed" && job.run_id) {
      ctx.write(
        ctx.db
          .updateTable("core_runs")
          .set({ status: "cancelled", outcome: "cancelled", summary: reason, ended_at: ctx.now })
          .where("id", "=", job.run_id)
          .where("status", "in", [...ACTIVE_RUN]),
      );
      ctx.write(
        ctx.db
          .updateTable("core_jobs")
          .set({ status: "cancelled", finished_at: ctx.now })
          .where("id", "=", job.id),
      );
      ctx.write(
        ctx.db
          .updateTable("core_leases")
          .set((eb) => ({
            fencing_token: eb("fencing_token", "+", 1),
            holder_kind: null,
            holder_id: null,
            released_at: ctx.now,
          }))
          .where("work_item_id", "=", session.work_item_id)
          .where("holder_id", "=", job.run_id),
      );
    }
  }
  logPlanning(ctx, session.work_item_id, "session.changed", { status, reason });
  ctx.change({ entity: "planning_session", id: session.id, after: { status, reason } });
}

// ---- the planning agent's side (a runner job) ----

export const specRevise = defineOperation({
  name: "spec.revise",
  description:
    "The planning agent replaces the living spec with a new revision: the whole spec (body, criteria, assumptions, coverage, clarifications), every statement tagged with its source (ADR 0302). Refused while the spec waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: specReviseInputSchema.extend(planningJobFields),
  output: z.object({ specId: z.string(), version: z.number() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    if (session.at_gate) {
      throw new OperationError(
        "conflict",
        "the spec is waiting at the gate: wait for a decision (changes arrive in the chat)",
      );
    }
    // An item on a Workflow without `splits` can't build a split (review of #171).
    if (input.children?.length && !has(w.workflow_version, "splits")) {
      throw new OperationError(
        "invalid_input",
        "this item's Workflow can't split work: plan it as one piece of work",
      );
    }
    // Depth 1 (spec 24, ADR 0303): a child's plan can't split again.
    if (input.children?.length && w.parent_work_item_id) {
      throw new OperationError(
        "invalid_input",
        "this item was split off a parent's plan, and a child can't split again (depth 1): plan it as one piece of work, or ask in the chat to change the parent's plan",
      );
    }
    // A person's edit stays word for word (ADR 0471): the planner asks before changing it.
    const dropped = droppedEdits(input.specMd, await standingEdits(ctx, w.id));
    if (dropped.length) {
      throw new OperationError(
        "conflict",
        `a person edited the plan, and this revision doesn't keep their wording: ${await describeEdits(ctx, dropped, input.specMd)}. Keep each word for word in its section, as many times as they wrote it, or ask them in the chat.`,
        { editIds: dropped.map((e) => e.id) },
      );
    }
    const latest = await ctx.db
      .selectFrom("core_specs")
      .select((eb) => eb.fn.max("version").as("v"))
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    const version = (latest?.v ?? 0) + 1;
    const specId = newId("spec");
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ status: "superseded" })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "draft"),
    );
    guardCurrentSpec(ctx, w, "the plan is still the version this revision replaces");
    ctx.write(
      ctx.db.insertInto("core_specs").values({
        id: specId,
        work_item_id: w.id,
        version,
        body_md: input.specMd,
        acceptance_criteria: json(input.acceptanceCriteria),
        assumptions: json(input.assumptions),
        coverage: json(input.coverage),
        clarifications: json(input.clarifications),
        summary: input.summary ?? null,
        children: input.children?.length ? json(input.children) : null,
        status: "draft",
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    // Guarded: a person's edit committed meanwhile changes the current plan, and this revision
    // (checked against the edits as they were) must not overwrite it (review of #85).
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ current_spec_id: specId, updated_at: ctx.now })
        .where("id", "=", w.id)
        .where((eb) =>
          w.current_spec_id === null
            ? eb("current_spec_id", "is", null)
            : eb("current_spec_id", "=", w.current_spec_id),
        ),
    );
    ctx.guardChanged("the plan is still the version this revision replaces");
    markWorking(ctx, session, "revising the spec");
    logPlanning(ctx, w.id, "spec.revised", { specId, version, summary: input.summary ?? null });
    ctx.change({
      entity: "spec",
      id: specId,
      after: { version, criteria: input.acceptanceCriteria.length },
    });
    return { specId, version };
  },
});

export const chatReply = defineOperation({
  name: "chat.reply",
  description: "The planning agent replies in the work item's planning chat.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: chatReplyInputSchema.extend(planningJobFields),
  output: z.object({ messageId: z.string() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    await assertAbout(ctx, w.id, input.questionId, input.replyTo);
    const messageId = newId("planningMessage");
    ctx.write(
      ctx.db.insertInto("core_planning_messages").values({
        id: messageId,
        work_item_id: w.id,
        author_kind: "agent",
        author_id: ctx.actor.id,
        text: input.text,
        question_id: input.questionId ?? null,
        reply_to: input.replyTo ?? null,
        created_at: ctx.now,
      }),
    );
    markWorking(ctx, session);
    logPlanning(ctx, w.id, "chat.reply", { messageId });
    await notifyAway(
      ctx,
      session,
      "planning.reply",
      `The planner replied on #${w.number}: ${w.title}`,
    );
    return { messageId };
  },
});

async function assertAbout(
  ctx: HandlerContext,
  item: string,
  questionId: string | undefined,
  replyTo: string | undefined,
) {
  if (questionId) {
    const q = await ctx.db
      .selectFrom("core_questions")
      .select("work_item_id")
      .where("id", "=", questionId)
      .executeTakeFirst();
    if (q?.work_item_id !== item) throw new OperationError("not_found", "no such question");
  }
  if (replyTo) {
    const m = await ctx.db
      .selectFrom("core_planning_messages")
      .select("work_item_id")
      .where("id", "=", replyTo)
      .executeTakeFirst();
    if (m?.work_item_id !== item) throw new OperationError("not_found", "no such message");
  }
}

const newsOutput = z.object({
  workItemId: z.string(),
  cursor: z.number(),
  events: z.array(z.record(z.string(), z.unknown())),
  openQuestions: z.number(),
  present: z.array(z.string()),
  yield: z.boolean(),
  ended: z.boolean(),
});

export const planningNews = defineOperation({
  name: "planning.news",
  description:
    "The planning agent's news since its cursor (spec 20): answers, revised answers, people's chat messages and presence changes. A hook passes `ack` (the last cursor it showed the agent) and `hold`, so news it couldn't show comes again (spec 26); without `hold` the news is marked read at once (the agent's own planning_news call).",
  risk: "write",
  // Called by the hooks between the agent's steps: audited when there is news (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.events.length > 0 },
  actors: ["runner"],
  permission: "signed-in",
  input: planningNewsInputSchema.extend(planningJobFields),
  output: newsOutput,
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const acked = await acknowledge(ctx, session, input.ack);
    // A cursor only re-reads: never past what was delivered (review of #67).
    const from = input.cursor === undefined ? acked : Math.min(input.cursor, acked);
    const news = await readNews(ctx, session.work_item_id, from);
    hand(ctx, session, news.cursor, news.delivered);
    // Without `hold` the caller is the agent itself, which sees the result: read now.
    if (!input.hold) deliver(ctx, session, news.cursor, news.delivered, acked);
    markWorking(ctx, session, input.activity);
    return { ...(await newsEnvelope(ctx, session)), cursor: news.cursor, events: news.events };
  },
});

export const planningPeek = defineOperation({
  name: "planning.peek",
  description:
    "Whether there is planning news after a cursor (default: the last one delivered), and whether the session must yield or has ended (spec 26). A read, so a hook's look between the agent's steps costs no write.",
  risk: "read",
  actors: ["runner"],
  permission: "signed-in",
  input: planningPeekInputSchema.extend(planningJobFields),
  output: z.object({
    latest: z.number(),
    news: z.boolean(),
    yield: z.boolean(),
    ended: z.boolean(),
  }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const from = Math.max(input.cursor ?? 0, session.delivered_cursor);
    const rows = await ctx.db
      .selectFrom("core_planning_events")
      .select(["id", "type"])
      .where("work_item_id", "=", session.work_item_id)
      .where("id", ">", from)
      .orderBy("id", "desc")
      .limit(200)
      .execute();
    return {
      latest: rows[0]?.id ?? from,
      news: rows.some((r) => (NEWS_EVENTS as readonly string[]).includes(r.type)),
      yield: session.yield_requested_at !== null,
      ended: !OPEN_SESSION.includes(session.status),
    };
  },
});

/**
 * Marks read what a hook says the agent was shown (`ack`, spec 26). The ack is clamped to the
 * highest cursor this session was actually handed, so nothing can mark unseen news read (review of
 * #67). Receipts go to exactly the answer revisions handed out. Returns the cursor news continues from.
 */
async function acknowledge(
  ctx: HandlerContext,
  session: PlanningSessionRow,
  ack: number | undefined,
): Promise<number> {
  const upTo = Math.min(ack ?? 0, session.handed_cursor);
  if (upTo <= session.delivered_cursor) return session.delivered_cursor;
  const shown = await readNews(ctx, session.work_item_id, session.delivered_cursor, upTo);
  const handed = parseJson<Record<string, number>>(session.handed_answers ?? "{}", {});
  deliver(ctx, session, upTo, {
    // Only the revision handed out: a later revision stays unread until it is shown.
    answers: shown.delivered.answers.flatMap((a) =>
      handed[a.questionId] !== undefined
        ? [{ ...a, revision: handed[a.questionId] as number }]
        : [],
    ),
    messageIds: shown.delivered.messageIds,
  });
  return upTo;
}

/**
 * Records what this call hands the harness: the cursor (the ceiling for a later ack) and each
 * answer's revision (what its receipt will mean).
 */
function hand(
  ctx: HandlerContext,
  session: PlanningSessionRow,
  cursor: number,
  delivered: Delivered,
) {
  const handed = parseJson<Record<string, number>>(session.handed_answers ?? "{}", {});
  for (const a of delivered.answers) handed[a.questionId] = a.revision;
  if (cursor <= session.handed_cursor && !delivered.answers.length) return;
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({
        handed_cursor: Math.max(cursor, session.handed_cursor),
        handed_answers: JSON.stringify(handed),
      })
      .where("id", "=", session.id),
  );
}

/**
 * Moves the session's cursor and marks exactly the answers (at their revision) and people's
 * messages it carried as read (spec 26: read receipts; anything past the page stays unread).
 */
function deliver(
  ctx: HandlerContext,
  session: PlanningSessionRow,
  cursor: number,
  delivered: Delivered,
  /** The cursor already moved to in this call (an `ack`). */
  floor = session.delivered_cursor,
) {
  if (cursor > floor) {
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ delivered_cursor: cursor })
        .where("id", "=", session.id)
        .where("delivered_cursor", "<", cursor),
    );
  }
  if (delivered.messageIds.length) {
    ctx.write(
      ctx.db
        .updateTable("core_planning_messages")
        .set({ delivered_at: ctx.now })
        .where("id", "in", delivered.messageIds)
        .where("delivered_at", "is", null),
    );
  }
  for (const a of delivered.answers) {
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ answer_delivered_at: ctx.now })
        .where("id", "=", a.questionId)
        .where("answer_revision", "=", a.revision)
        .where("answer_delivered_at", "is", null),
    );
  }
}

export const planningWait = defineOperation({
  name: "planning.wait",
  description:
    "The planning agent's Stop hook waits for news (spec 20, kim's batch rule): due once a person has paused 15 s after their latest answer, at once after a chat message or when no question is left open. This evaluates once and answers `due: false` with when to look again; sf-engine's channel holds the call and re-evaluates on every change. A wait that asks the session to yield answers `yield: true`.",
  risk: "write",
  // Re-evaluated on every change and every 50 s: audited when news is handed over or the
  // session changes (logPlanning marks it), ADR 0590.
  audit: { changesOnly: true, changed: (out) => out.due || out.events.length > 0 },
  actors: ["runner"],
  permission: "signed-in",
  input: planningWaitInputSchema.extend(planningJobFields),
  output: newsOutput.extend({ due: z.boolean(), recheckAt: z.string().nullable() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const acked = await acknowledge(ctx, session, input.ack);
    const from = input.cursor === undefined ? acked : Math.min(input.cursor, acked);
    const news = await readNews(ctx, session.work_item_id, from);
    const envelope = await newsEnvelope(ctx, session);
    const dueAt = batchDue(news.userEvents, envelope.openQuestions, input.idleMs);
    // A paused planner isn't woken by news until a person resumes it (ADR 0470).
    const due = session.paused_at === null && dueAt !== null && dueAt <= Date.parse(ctx.now);
    if (due) {
      hand(ctx, session, news.cursor, news.delivered);
      if (!input.hold) deliver(ctx, session, news.cursor, news.delivered, acked);
      markWorking(ctx, session);
      return { ...envelope, cursor: news.cursor, events: news.events, due, recheckAt: null };
    }
    // Waiting: no tokens spent, a light slot held (ADR 0301).
    if (session.status !== "idle" && session.status !== "yielding") {
      ctx.write(
        ctx.db
          .updateTable("core_planning_sessions")
          .set({
            status: "idle",
            idle_since: ctx.now,
            agent_seen_at: ctx.now,
            activity: null,
            updated_at: ctx.now,
          })
          .where("id", "=", session.id),
      );
      logPlanning(ctx, session.work_item_id, "session.changed", { status: "idle" });
      if (await agentDrafted(ctx)) await announce(ctx, session);
    } else {
      ctx.write(
        ctx.db
          .updateTable("core_planning_sessions")
          .set({ agent_seen_at: ctx.now })
          .where("id", "=", session.id),
      );
    }
    return {
      ...envelope,
      cursor: from,
      events: [],
      due: false,
      recheckAt: dueAt === null || session.paused_at ? null : new Date(dueAt).toISOString(),
    };
  },
});

export const planningYield = defineOperation({
  name: "planning.yield",
  description:
    "The planning agent gives up its runner slot because the scheduler asked (ADR 0301). The host then ends the harness and hands the run back; the next answer or chat message resumes the same conversation on the same runner.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object(planningJobFields),
  output: z.object({ yielded: z.boolean() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ status: "yielding", updated_at: ctx.now })
        .where("id", "=", session.id),
    );
    logPlanning(ctx, session.work_item_id, "session.changed", { status: "yielding" });
    return { yielded: true };
  },
});

export const planningReady = defineOperation({
  name: "planning.ready",
  description:
    "The planning agent asks for the spec gate: the spec is drafted and every blocking question is answered. The Workflow then opens the gate; the spec can't be revised until a person decides.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: planningReadyInputSchema.extend(planningJobFields),
  output: z.object({ specId: z.string(), round: z.number() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    if (session.at_gate && session.ready_spec_id) {
      return { specId: session.ready_spec_id, round: session.round };
    }
    if (!w.current_spec_id) throw new OperationError("conflict", "revise the spec first");
    // No gate on stale news (ADR 0470): a person's answer or message the agent hasn't read yet.
    // Checked now and guarded in the batch, so one arriving meanwhile fails this call instead.
    const read = await acknowledge(ctx, session, input.ack);
    const unread = await hasUnreadPersonNews(ctx, w.id, read);
    if (unread) {
      throw new OperationError(
        "conflict",
        `a person answered or wrote since you last looked (${unread} event${unread === 1 ? "" : "s"}): call planning_news, act on it, then ask for the gate again`,
      );
    }
    guardNoUnreadPersonNews(ctx, w.id, read);
    // Every person's standing edit must still be in the plan going to the gate (review of #85).
    const spec = await ctx.db
      .selectFrom("core_specs")
      .select("body_md")
      .where("id", "=", w.current_spec_id)
      .executeTakeFirst();
    const notKept = droppedEdits(spec?.body_md ?? "", await standingEdits(ctx, w.id));
    if (notKept.length) {
      throw new OperationError(
        "conflict",
        `the plan doesn't keep these edits word for word: ${await describeEdits(ctx, notKept, spec?.body_md ?? "")}. Restore them with spec_revise, or ask the person in the chat to release the edit (they can, under the plan)`,
        { editIds: notKept.map((e) => e.id) },
      );
    }
    // Spec 22: pulled .kim/ files that changed on the default branch must be merged first.
    const conflicts = await kimConflicts(ctx, w);
    if (conflicts.length) {
      throw new OperationError(
        "conflict",
        `${conflicts.map((c) => c.path).join(", ")} changed on the default branch since you pulled ${conflicts.length === 1 ? "it" : "them"}: design_pull ${conflicts.length === 1 ? "it" : "each"} again (it takes the new copy as the base), merge your changes into it with artifact_update, then ask for the gate again`,
        { paths: conflicts.map((c) => c.path) },
      );
    }
    const open = await ctx.db
      .selectFrom("core_questions")
      .select("number")
      .where("work_item_id", "=", w.id)
      .where("status", "=", "open")
      .where("blocking", "=", 1)
      .execute();
    if (open.length) {
      throw new OperationError(
        "conflict",
        `blocking questions are still open: ${open.map((q) => `Q${q.number ?? "?"}`).join(", ")}`,
      );
    }
    // A gate the Workflow opened after a person took the spec back is stale: withdraw it, and the
    // Workflow's next round opens the gate on this request (ADR 0470).
    await withdrawSpecGate(ctx, w.id, "withdrawn: the planner asked for the gate again");
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({
          ready_spec_id: w.current_spec_id,
          ready_at: ctx.now,
          at_gate: 1,
          updated_at: ctx.now,
        })
        .where("id", "=", session.id)
        .where("at_gate", "=", 0)
        .where("round", "=", session.round),
    );
    ctx.guardChanged("the round hasn't moved since the planner looked");
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: w.workflow_id,
        type: planningReadyEvent(w.id, session.round),
        payload: { specId: w.current_spec_id, note: input.note ?? null },
      },
    });
    logPlanning(ctx, w.id, "gate.ready", { specId: w.current_spec_id, note: input.note ?? null });
    await announce(ctx, session);
    return { specId: w.current_spec_id, round: session.round };
  },
});

// ---- people's side ----

export const chatSend = defineOperation({
  name: "chat.send",
  description:
    "A person writes in the work item's planning chat, optionally about a question or replying to a message. It reaches the planning agent after its current step, or at once with `interrupt` (the agent's current step is stopped, ADR 0470), and wakes an idle or yielded session. While the spec waits at the gate it takes the spec back.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  // An interrupt comes only from a person in the app or on the desktop (review of #71); a plain
  // message may come from anywhere a member may write.
  browserOnly: (input) => input.interrupt === true,
  desktopDecidable: true,
  input: z.object({
    workItemId,
    text: z.string().trim().min(1).max(20_000),
    questionId: z.string().min(1).optional(),
    replyTo: z.string().min(1).optional(),
    /** Stop the planner's current step so it reads this now (⌘-Enter, ADR 0470). */
    interrupt: z.boolean().optional(),
    /** Spec 21: a comment pinned to a spot in an artifact (the element, and where it is). */
    pin: pinSchema.optional(),
    /** A comment on plan lines (spec 27): the plan version, the lines and what they read. */
    anchor: z
      .object({
        specId: z.string().min(1),
        lineStart: z.number().int().nonnegative(),
        lineEnd: z.number().int().nonnegative(),
        quote: z.string().max(4_000),
      })
      .optional(),
  }),
  output: z.object({
    messageId: z.string(),
    /** Whether the planner was interrupted; otherwise it reads the message after its current step. */
    interrupted: z.boolean(),
    /** Why an interrupt asked for didn't happen. */
    note: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    await assertAbout(ctx, w.id, input.questionId, input.replyTo);
    if (input.pin) await liveArtifact(ctx, w.id, input.pin.artifactId);
    if (input.anchor) {
      const anchored = await ctx.db
        .selectFrom("core_specs")
        .select(["work_item_id", "body_md"])
        .where("id", "=", input.anchor.specId)
        .executeTakeFirst();
      if (anchored?.work_item_id !== w.id) {
        throw new OperationError("not_found", "no such plan version");
      }
      // The quote is what those lines of that version say (review of #85, round 2).
      const { lineStart, lineEnd, quote } = input.anchor;
      const said = anchored.body_md
        .split("\n")
        .slice(lineStart, lineEnd + 1)
        .join("\n");
      if (lineEnd < lineStart || said !== quote) {
        throw new OperationError(
          "invalid_input",
          "the comment's quote isn't what those lines of the plan say: look again",
        );
      }
    }
    const messageId = newId("planningMessage");
    ctx.write(
      ctx.db.insertInto("core_planning_messages").values({
        id: messageId,
        work_item_id: w.id,
        author_kind: "person",
        author_id: ctx.actor.id,
        text: input.text,
        question_id: input.questionId ?? null,
        reply_to: input.replyTo ?? null,
        anchor: input.anchor ? JSON.stringify(input.anchor) : null,
        pin: input.pin ? JSON.stringify(input.pin) : null,
        created_at: ctx.now,
      }),
    );
    logPlanning(ctx, w.id, "chat.message", { messageId, interrupt: input.interrupt ?? false });
    const gate = await takeBackFromGate(ctx, w, "a person wrote in the chat");
    await wakeSession(ctx, w);
    let interrupted = false;
    // The spec was approved a moment before this arrived: say so instead of losing it quietly.
    let note: string | null =
      gate === "decided"
        ? "The spec was approved a moment ago, so the planner won't read this. Tell the approver if it changes anything."
        : null;
    if (input.interrupt && !note) {
      const session = await openSession(ctx, w.id);
      const result = session
        ? await interruptPlanning(ctx, session, PLANNING_INTERRUPT_LINES.message)
        : { interrupted: false, reason: "no planning session is open" };
      interrupted = result.interrupted;
      note = result.reason;
    }
    return { messageId, interrupted, note };
  },
});

export const planningPresence = defineOperation({
  name: "planning.presence",
  description:
    "The app reports that the signed-in person has the Planning view open (a heartbeat every ~20 s) or closed it. The planning agent sees who is here in its news.",
  risk: "write",
  // Every 20 s per open Planning tab: audited when someone arrives or leaves (ADR 0590).
  audit: { changesOnly: true },
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, open: z.boolean() }),
  output: z.object({ present: z.array(z.string()) }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const before = await presentPeople(ctx, w.id);
    const wasHere = before.some((p) => p.userId === ctx.actor.id);
    ctx.write(
      ctx.db
        .insertInto("core_planning_presence")
        .values({
          work_item_id: w.id,
          user_id: ctx.actor.id,
          seen_at: ctx.now,
          left_at: input.open ? null : ctx.now,
        })
        .onConflict((oc) =>
          oc.columns(["work_item_id", "user_id"]).doUpdateSet({
            seen_at: ctx.now,
            left_at: input.open ? null : ctx.now,
          }),
        ),
    );
    const others = before.filter((p) => p.userId !== ctx.actor.id).map((p) => p.name);
    const me = (
      await ctx.db
        .selectFrom("core_user")
        .select(["name", "github_login"])
        .where("id", "=", ctx.actor.id)
        .executeTakeFirst()
    )?.name;
    const present = input.open ? [...others, me ?? ctx.actor.id] : others;
    if (wasHere !== input.open) logPlanning(ctx, w.id, "presence.changed", { present });
    return { present };
  },
});

export const planningMove = defineOperation({
  name: "planning.move",
  description:
    "Continue on another runner (spec 20): end the session where it is (its runner's session is fenced when it returns) and start a fresh one, rebuilt from the planning record (spec revisions, questions and answers, chat), on any runner or the one named.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, runnerId: z.string().min(1).optional() }),
  output: z.object({ sessionId: z.string(), jobId: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const old = await openSession(ctx, w.id);
    if (!old) throw new OperationError("conflict", "no open planning session to move");
    if (input.runnerId) {
      const runner = await ctx.db
        .selectFrom("core_runners")
        .select(["id", "revoked_at"])
        .where("id", "=", input.runnerId)
        .executeTakeFirst();
      if (!runner || runner.revoked_at) throw new OperationError("not_found", "no such runner");
    }
    await stopSession(ctx, old, "moved", "continued on another runner");
    const session = {
      id: newId("planningSession"),
      session_ref: crypto.randomUUID(),
      runner_id: null,
    };
    const jobIdValue = enqueuePlanningJob(ctx, w, session, {
      resume: false,
      prompt: await planningPrompt(ctx, w, { moved: true }),
      pinnedRunnerId: input.runnerId ?? null,
    });
    const last = await ctx.db
      .selectFrom("core_planning_events")
      .select((eb) => eb.fn.max("id").as("id"))
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    ctx.write(
      ctx.db.insertInto("core_planning_sessions").values({
        id: session.id,
        work_item_id: w.id,
        session_ref: session.session_ref,
        status: "starting",
        current_job_id: jobIdValue,
        // The fresh prompt carries the whole record: news starts after it.
        delivered_cursor: Number(last?.id ?? 0),
        round: old.round,
        ready_spec_id: old.ready_spec_id,
        ready_at: old.ready_at,
        at_gate: old.at_gate,
        announced_at: old.announced_at,
        replaces_session_id: old.id,
        created_by: ctx.actor.id,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    logPlanning(ctx, w.id, "session.changed", { status: "starting", moved: true });
    return { sessionId: session.id, jobId: jobIdValue };
  },
});

// ---- steering the planner (ADR 0470) ----

export const planningStop = defineOperation({
  name: "planning.stop",
  description:
    "A person stops the planning agent's current step (the activity line's Stop, ADR 0470). The session stays open: the agent ends its turn and waits. Needs a runner that can interrupt; an idle agent has nothing to stop.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  // Only a person, in the app or on the desktop: never a CLI or MCP token (review of #71).
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId }),
  output: z.object({ stopped: z.boolean(), note: z.string().nullable() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    const result = await interruptPlanning(ctx, session, PLANNING_INTERRUPT_LINES.stop);
    if (result.interrupted) logPlanning(ctx, w.id, "planning.stopped", {});
    return { stopped: result.interrupted, note: result.reason };
  },
});

export const planningPause = defineOperation({
  name: "planning.pause",
  description:
    "A person pauses the planning agent (ADR 0470): its current step is stopped, and news (answers, chat) doesn't wake it until someone resumes it with planning.resume. A paused session yields its runner slot when the light pool needs it, as an idle one does.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  // Only a person, in the app or on the desktop: never a CLI or MCP token (review of #71).
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId }),
  output: z.object({ paused: z.boolean(), interrupted: z.boolean() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    if (session.paused_at) return { paused: true, interrupted: false };
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ paused_at: ctx.now, paused_by: ctx.actor.id, updated_at: ctx.now })
        .where("id", "=", session.id),
    );
    logPlanning(ctx, w.id, "planning.paused", {});
    const { interrupted } = await interruptPlanning(ctx, session, PLANNING_INTERRUPT_LINES.pause);
    return { paused: true, interrupted };
  },
});

export const planningResume = defineOperation({
  name: "planning.resume",
  description:
    "A person resumes a paused planning agent (ADR 0470): it wakes at once with everything that arrived while it was paused, and a yielded session is resumed on its runner.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  // Only a person, in the app or on the desktop: never a CLI or MCP token (review of #71).
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId }),
  output: z.object({ resumed: z.boolean() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    if (!session.paused_at) return { resumed: false };
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ paused_at: null, paused_by: null, updated_at: ctx.now })
        .where("id", "=", session.id),
    );
    logPlanning(ctx, w.id, "planning.resumed", {});
    await wakeSession(ctx, w, { resuming: true });
    return { resumed: true };
  },
});

export const specEdit = defineOperation({
  name: "spec.edit",
  description:
    "A person edits lines of the work item's living plan (spec 27, ADR 0471): the source lines lineStart..lineEnd (0-based, inclusive) of the current version, which must still read `before`, become `after`. A new plan version by this person; the planner hears it, keeps the wording word for word, and records the answers it settles. While the spec waits at the gate, it takes it back.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({
    workItemId,
    specId: z.string().min(1),
    lineStart: z.number().int().nonnegative(),
    lineEnd: z.number().int().nonnegative(),
    before: z.string().max(20_000),
    after: z.string().max(20_000),
  }),
  output: z.object({ specId: z.string(), version: z.number(), editId: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (input.lineEnd < input.lineStart) {
      throw new OperationError("invalid_input", "lineEnd comes before lineStart");
    }
    const session = await openSession(ctx, w.id);
    if (!session) throw new OperationError("conflict", "no open planning session");
    if (w.current_spec_id !== input.specId) {
      throw new OperationError(
        "conflict",
        "the plan changed since you started editing: look again",
      );
    }
    const spec = await ctx.db
      .selectFrom("core_specs")
      .selectAll()
      .where("id", "=", input.specId)
      .executeTakeFirst();
    if (!spec) throw new OperationError("not_found", "no such plan version");
    const lines = spec.body_md.split("\n");
    if (input.lineEnd >= lines.length) {
      throw new OperationError("invalid_input", "those lines aren't in the plan");
    }
    const current = lines.slice(input.lineStart, input.lineEnd + 1).join("\n");
    if (current !== input.before) {
      throw new OperationError(
        "conflict",
        "those lines changed since you started editing: look again",
      );
    }
    if (input.after === input.before) {
      throw new OperationError("invalid_input", "nothing changed");
    }
    // The edit must be whole blocks, and read in the plan as it reads alone (review of #85, round 2).
    const planned = editFootprint(spec.body_md, input.lineStart, input.lineEnd, input.after);
    if (!planned.ok) throw new OperationError("invalid_input", planned.reason);
    // A tag that says a question decided this line must be true (review of #85): an edit can't
    // put [Q3] on a line while Q3 is still open.
    const added = [...input.after.matchAll(/\[Q(\d+)\]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => !input.before.includes(`[Q${n}]`));
    if (added.length) {
      const tagged = await ctx.db
        .selectFrom("core_questions")
        .select(["number", "status"])
        .where("work_item_id", "=", w.id)
        .where("number", "in", added)
        .execute();
      const notDecided = added.filter(
        (n) => tagged.find((q) => q.number === n)?.status !== "answered",
      );
      if (notDecided.length) {
        throw new OperationError(
          "invalid_input",
          `${notDecided.map((n) => `Q${n}`).join(", ")} isn't answered yet, so a line can't cite it as decided: answer it first, or tag the line [assumption]`,
        );
      }
    }
    // An edit after the spec was approved would land on a plan nobody builds (review of #85).
    if ((await takeBackFromGate(ctx, w, "a person edited the plan")) === "decided") {
      throw new OperationError(
        "conflict",
        "the plan was just approved: edits no longer reach it. Ask the approver to send it back if it must change",
      );
    }
    const body = planned.result;
    const latest = await ctx.db
      .selectFrom("core_specs")
      .select((eb) => eb.fn.max("version").as("v"))
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    const version = (latest?.v ?? 0) + 1;
    const specIdValue = newId("spec");
    const editId = newId("specEdit");
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ status: "superseded" })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "draft"),
    );
    guardCurrentSpec(ctx, w, "the plan is still the version edited");
    ctx.write(
      ctx.db.insertInto("core_specs").values({
        id: specIdValue,
        work_item_id: w.id,
        version,
        body_md: body,
        acceptance_criteria: spec.acceptance_criteria,
        assumptions: spec.assumptions,
        coverage: spec.coverage,
        clarifications: spec.clarifications,
        children: spec.children,
        summary: "edited by a person",
        status: "draft",
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    // Guarded: the plan must still be the one the person edited when this commits.
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ current_spec_id: specIdValue, updated_at: ctx.now })
        .where("id", "=", w.id)
        .where("current_spec_id", "=", input.specId),
    );
    ctx.guardChanged("the plan is still the version edited");
    // A person's edit that moves structure (a heading renamed, inserted, deleted or reordered above,
    // a parent item reworded) carries the edits it moves along, in this batch, so nobody is stuck
    // (fourth review of #85).
    const moves = structureMoves(
      spec.body_md,
      body,
      input.lineStart,
      input.lineEnd,
      input.after.trim() === "" ? 0 : input.after.split("\n").length,
    );
    const standing = (await standingEdits(ctx, w.id)).map((e) => {
      const footprint = rekeyFootprint(e.footprint, moves);
      return { ...e, moved: !sameFootprint(footprint, e.footprint), footprint };
    });
    for (const e of standing.filter((x) => x.moved)) {
      ctx.write(
        ctx.db
          .updateTable("core_spec_edits")
          .set({ footprint: JSON.stringify(e.footprint) })
          .where("id", "=", e.id)
          .where("replaced_by", "is", null),
      );
    }
    // A person's later word stands: an earlier edit this one overrides (it removed a block that edit
    // wrote, or wrote back what that edit removed) is retired. Any other edit the plan stops keeping
    // stays, listed as not kept with the reason, until a person releases it: never dropped silently.
    const mine = { id: editId, footprint: planned.footprint };
    const key = (k: { section: string; parent?: string; text: string }) =>
      `${k.section}␟${k.parent ?? ""}␟${k.text}`;
    const removedKeys = new Set(planned.footprint.gone.map(key));
    const covered = droppedEdits(body, [mine, ...standing])
      .filter((e) => e.id !== editId)
      .filter(
        (e) =>
          e.footprint.blocks.some((b) => removedKeys.has(key(b))) ||
          e.footprint.gone.some(
            (g) => droppedEdits(body, [{ footprint: { blocks: [], gone: [g] } }]).length > 0,
          ),
      );
    // Retire first, then count: an edit that frees slots isn't refused (fourth review of #85, 4).
    if (standing.length - covered.length + 1 > STANDING_EDITS_MAX) {
      throw new OperationError(
        "conflict",
        `this plan already holds ${STANDING_EDITS_MAX} people's edits the planner must keep: release some (under the plan) before editing more`,
      );
    }
    if (covered.length) {
      ctx.write(
        ctx.db
          .updateTable("core_spec_edits")
          .set({ replaced_by: editId })
          .where(
            "id",
            "in",
            covered.map((e) => e.id),
          )
          .where("replaced_by", "is", null),
      );
    }
    ctx.write(
      ctx.db.insertInto("core_spec_edits").values({
        id: editId,
        work_item_id: w.id,
        spec_id: specIdValue,
        base_spec_id: input.specId,
        line_start: input.lineStart,
        line_end: input.lineEnd,
        before: input.before,
        after: input.after,
        author_id: ctx.actor.id,
        created_at: ctx.now,
        footprint: JSON.stringify(planned.footprint),
      }),
    );
    logPlanning(ctx, w.id, "spec.edited", { editId, specId: specIdValue, version });
    await wakeSession(ctx, w);
    ctx.change({ entity: "spec", id: specIdValue, after: { version, editId } });
    return { specId: specIdValue, version, editId };
  },
});

export const specReleaseEdit = defineOperation({
  name: "spec.releaseEdit",
  description:
    "A person lets the planner reword their edit to the plan (spec 27, review of #85): the edit stops standing, so a revision no longer has to keep it word for word. The planner hears it.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  desktopDecidable: true,
  input: z.object({ workItemId, editId: z.string().min(1) }),
  output: z.object({ editId: z.string(), released: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const edit = await ctx.db
      .selectFrom("core_spec_edits")
      .select(["id", "work_item_id", "released_at", "replaced_by"])
      .where("id", "=", input.editId)
      .executeTakeFirst();
    if (!edit || edit.work_item_id !== w.id) throw new OperationError("not_found", "no such edit");
    if (edit.released_at || edit.replaced_by) return { editId: edit.id, released: false };
    ctx.write(
      ctx.db
        .updateTable("core_spec_edits")
        .set({ released_at: ctx.now, released_by: ctx.actor.id })
        .where("id", "=", edit.id)
        .where("released_at", "is", null),
    );
    // The planner hears it as this person's message, like any word of theirs.
    const messageId = newId("planningMessage");
    ctx.write(
      ctx.db.insertInto("core_planning_messages").values({
        id: messageId,
        work_item_id: w.id,
        author_kind: "person",
        author_id: ctx.actor.id,
        text: "You may reword my edit to the plan now; keep its meaning.",
        created_at: ctx.now,
      }),
    );
    logPlanning(ctx, w.id, "chat.message", { messageId, releasedEdit: edit.id });
    await wakeSession(ctx, w);
    return { editId: edit.id, released: true };
  },
});

const questionView = z.object({
  id: z.string(),
  number: z.number().nullable(),
  kind: z.string(),
  prompt: z.string(),
  context: z.string().nullable(),
  options: z.array(z.string()),
  defaultValues: z.array(z.string()).nullable(),
  defaultAnswer: z.string().nullable(),
  recommendation: z.string().nullable(),
  recommendationReason: z.string().nullable(),
  domain: z.string(),
  blocking: z.boolean(),
  irreversible: z.boolean(),
  status: z.string(),
  answer: z.string().nullable(),
  note: z.string().nullable(),
  acceptedDefault: z.boolean(),
  /** Accepted under a person's "finish alone" instruction; answeredBy is that person. */
  acceptedAlone: z.boolean(),
  /** Recorded by the planner from this person's plan edit (spec 27). */
  answeredViaEdit: z.string().nullable(),
  /** Spec 21: links to the planner's mockups. */
  artifactId: z.string().nullable(),
  optionArtifacts: z.record(z.string(), z.string()).nullable(),
  optionValues: z.record(z.string(), z.record(z.string(), z.string())).nullable(),
  control: z.string().nullable(),
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  step: z.number().nullable(),
  skipped: z.boolean(),
  /** When this answer reached the planning agent (a read receipt); null until then. */
  answerDeliveredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answerRevision: z.number(),
  revision: z.number(),
  position: z.number(),
  assignee: z.string().nullable(),
  escalated: z.boolean(),
  planning: z.boolean(),
});
const specView = z.object({
  id: z.string(),
  version: z.number(),
  bodyMd: z.string(),
  acceptanceCriteria: z.array(z.string()),
  assumptions: z.array(z.string()),
  coverage: z.array(z.record(z.string(), z.unknown())),
  clarifications: z.array(z.record(z.string(), z.unknown())),
  /** Spec 24: the work items this version splits into, approved with it. */
  children: z.array(specChildSchema).default([]),
  summary: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  /** The spec critic's notes on this version (spec 23 part C); null until it has run. */
  critique: z
    .object({
      status: z.enum(["done", "timed_out", "failed"]),
      notes: z.array(z.string()),
      summary: z.string().nullable(),
      at: z.string(),
    })
    .nullable(),
});

export const planningGet = defineOperation({
  name: "planning.get",
  description:
    "The Planning view (spec 20): the session (state, runner, whether it waits for its runner), every question with its answer, the current spec and the one before it (to highlight what changed), the chat, who is here, and the log's cursor.",
  // Polled: reads nothing an org workflow decides (spec 52 PR (d), cost).
  skipsOrgWorkflow: true,
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({
    cursor: z.number(),
    session: z
      .object({
        id: z.string(),
        status: z.string(),
        activity: z.string().nullable(),
        idleSince: z.string().nullable(),
        agentSeenAt: z.string().nullable(),
        atGate: z.boolean(),
        ready: z.boolean(),
        yieldRequested: z.boolean(),
        /** A person paused it (ADR 0470): news doesn't wake it until resumed. */
        paused: z.boolean(),
        pausedBy: z.string().nullable(),
        /** Its runner can interrupt the current step (⌘-Enter, Stop); else messages wait for the step. */
        canInterrupt: z.boolean(),
        /** Spec 21: the artifact the planner put on screen last. */
        shownArtifactId: z.string().nullable(),
        /** "Let the planner finish alone" is on: who set it and when (ADR 0470). */
        finishAlone: z.object({ by: z.string(), byName: z.string(), at: z.string() }).nullable(),
        focusedQuestionId: z.string().nullable(),
        runner: z
          .object({
            id: z.string(),
            name: z.string(),
            online: z.boolean(),
            lastSeenAt: z.string().nullable(),
          })
          .nullable(),
        waitingForRunner: z.boolean(),
        createdAt: z.string(),
      })
      .nullable(),
    questions: z.array(questionView),
    spec: specView.nullable(),
    previousSpec: specView.nullable(),
    messages: z.array(
      z.object({
        id: z.string(),
        author: z.enum(["person", "agent"]),
        authorId: z.string(),
        authorName: z.string(),
        text: z.string(),
        questionId: z.string().nullable(),
        replyTo: z.string().nullable(),
        kind: z.string(),
        deliveredAt: z.string().nullable(),
        createdAt: z.string(),
        /** Spec 21: a comment pinned to a spot in an artifact. */
        pin: pinSchema.nullable(),
        /** A comment on plan lines (spec 27). */
        anchor: z
          .object({
            specId: z.string(),
            lineStart: z.number(),
            lineEnd: z.number(),
            quote: z.string(),
          })
          .nullable(),
      }),
    ),
    /** Spec 21: the planner's mockups, diagrams and documents (latest revision, no content). */
    artifacts: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        revision: z.number(),
        keep: z.boolean(),
        controls: z.array(z.string()),
        size: z.number(),
        updatedAt: z.string(),
        /** A design's type (spec 22); null for mockups, diagrams and documents. */
        designType: z.string().nullable(),
        /**
         * The `.kim/` file it was pulled from (spec 22); its base there is revision 0, which the app
         * compares the latest revision with.
         */
        pulledPath: z.string().nullable(),
      }),
    ),
    /** People's standing edits to the plan (spec 27): the planner keeps them word for word. */
    edits: z.array(
      z.object({
        id: z.string(),
        specId: z.string(),
        lineStart: z.number(),
        lineEnd: z.number(),
        before: z.string(),
        after: z.string(),
        authorId: z.string(),
        authorName: z.string(),
        createdAt: z.string(),
        /** Whether the current plan keeps it word for word (shown at the gate when it doesn't). */
        kept: z.boolean(),
        /** Why the plan doesn't keep it (its section is gone, what it removed is back…). */
        whyNotKept: z.string().nullable(),
        /** Lines the planner wrote that mention what this edit removed (listed, not refused). */
        mentions: z.array(z.string()),
        /** The blocks it wrote, by section and parent: the plan's blocks that show as this person's. */
        blocks: z.array(z.object({ section: z.string(), parent: z.string(), text: z.string() })),
      }),
    ),
    present: z.array(z.object({ userId: z.string(), name: z.string() })),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const [session, questions, specs, messages, last, present, edits, artifacts] =
      await Promise.all([
        ctx.db
          .selectFrom("core_planning_sessions")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst(),
        ctx.db
          .selectFrom("core_questions")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .where("status", "!=", "withdrawn")
          .orderBy("position")
          .orderBy("created_at")
          .execute(),
        ctx.db
          .selectFrom("core_specs")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("version", "desc")
          .limit(2)
          .execute(),
        ctx.db
          .selectFrom("core_planning_messages")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("created_at")
          .limit(500)
          .execute(),
        ctx.db
          .selectFrom("core_planning_events")
          .select((eb) => eb.fn.max("id").as("id"))
          .where("work_item_id", "=", w.id)
          .executeTakeFirst(),
        presentPeople(ctx, w.id),
        standingEdits(ctx, w.id),
        ctx.db
          .selectFrom("core_planning_artifacts as a")
          .innerJoin("core_planning_artifact_revisions as r", (j) =>
            j.onRef("r.artifact_id", "=", "a.id").onRef("r.revision", "=", "a.revision"),
          )
          .select([
            "a.id",
            "a.kind",
            "a.design_type",
            "a.pulled_path",
            "a.title",
            "a.description",
            "a.revision",
            "a.keep",
            "a.updated_at",
            "r.controls",
            "r.size",
          ])
          .where("a.work_item_id", "=", w.id)
          .where("a.deleted_at", "is", null)
          .orderBy("a.created_at")
          .execute(),
      ]);
    const runner = session?.runner_id
      ? await ctx.db
          .selectFrom("core_runners")
          .select(["id", "name", "last_seen_at", "manifest"])
          .where("id", "=", session.runner_id)
          .executeTakeFirst()
      : undefined;
    const online =
      !!runner?.last_seen_at &&
      Date.parse(ctx.now) - Date.parse(runner.last_seen_at) <= RUNNER_OFFLINE_MS;
    const people = new Map<string, string>();
    const ids = [
      ...new Set([
        ...messages.filter((m) => m.author_kind === "person").map((m) => m.author_id),
        ...(session?.finish_alone_by ? [session.finish_alone_by] : []),
        ...edits.map((e) => e.author_id),
      ]),
    ];
    if (ids.length) {
      for (const u of await ctx.db
        .selectFrom("core_user")
        .select(["id", "name", "github_login"])
        .where("id", "in", ids)
        .execute())
        people.set(u.id, u.name || u.github_login || u.id);
    }
    const toSpec = (s: (typeof specs)[number]) => ({
      id: s.id,
      version: s.version,
      bodyMd: s.body_md,
      acceptanceCriteria: parseJson<string[]>(s.acceptance_criteria, []),
      assumptions: parseJson<string[]>(s.assumptions, []),
      coverage: parseJson<Record<string, unknown>[]>(s.coverage, []),
      clarifications: parseJson<Record<string, unknown>[]>(s.clarifications, []),
      children: childrenOf(s.children),
      summary: s.summary,
      status: s.status,
      createdAt: s.created_at,
      createdBy: s.created_by,
      critique: s.critique ? critiqueOf(s.critique) : null,
    });
    const current = specs.find((s) => s.id === w.current_spec_id) ?? specs[0];
    // Edits are kept in order, each taking the copies it wrote (review of #85, round 2).
    const notKept = new Set(current ? droppedEdits(current.body_md, edits).map((e) => e.id) : []);
    const previous = specs.find((s) => current && s.version < current.version);
    const open = session && OPEN_SESSION.includes(session.status);
    return {
      cursor: Number(last?.id ?? 0),
      session: session
        ? {
            id: session.id,
            status: session.status,
            activity: session.activity,
            idleSince: session.idle_since,
            agentSeenAt: session.agent_seen_at,
            atGate: session.at_gate === 1,
            ready: session.ready_spec_id !== null,
            yieldRequested: session.yield_requested_at !== null,
            paused: session.paused_at !== null,
            pausedBy: session.paused_by,
            shownArtifactId: session.shown_artifact_id,
            canInterrupt: ["steer", "interrupt"].every((c) =>
              (
                parseJson<{ capabilities?: string[] }>(runner?.manifest ?? "{}", {}).capabilities ??
                []
              ).includes(c),
            ),
            finishAlone:
              session.finish_alone_by && session.finish_alone_at
                ? {
                    by: session.finish_alone_by,
                    byName: people.get(session.finish_alone_by) ?? session.finish_alone_by,
                    at: session.finish_alone_at,
                  }
                : null,
            focusedQuestionId: session.focused_question_id,
            runner: runner
              ? { id: runner.id, name: runner.name, online, lastSeenAt: runner.last_seen_at }
              : null,
            // The session waits for its own runner while it is offline (ADR 0300).
            waitingForRunner: !!open && !!runner && !online,
            createdAt: session.created_at,
          }
        : null,
      questions: questions.map((q) => ({
        id: q.id,
        number: q.number,
        kind: q.kind,
        prompt: q.prompt,
        context: q.context,
        options: parseJson<string[]>(q.options, []),
        defaultValues: q.default_values ? parseJson<string[]>(q.default_values, []) : null,
        defaultAnswer: q.default_answer,
        recommendation: q.recommendation,
        recommendationReason: q.recommendation_reason,
        domain: q.domain,
        blocking: q.blocking === 1,
        irreversible: q.irreversible === 1,
        status: q.status,
        answer: q.answer,
        note: q.note,
        acceptedDefault: q.accepted_default === 1,
        acceptedAlone: q.accepted_alone === 1,
        answeredViaEdit: q.answered_via_edit,
        artifactId: q.artifact_id,
        optionArtifacts: q.option_artifacts
          ? parseJson<Record<string, string>>(q.option_artifacts, {})
          : null,
        optionValues: q.option_values
          ? parseJson<Record<string, Record<string, string>>>(q.option_values, {})
          : null,
        control: q.control,
        unit: q.unit,
        min: q.min,
        max: q.max,
        step: q.step,
        skipped: q.skipped === 1,
        answerDeliveredAt: q.answer_delivered_at,
        answeredBy: q.answered_by,
        answeredAt: q.answered_at,
        answerRevision: q.answer_revision,
        revision: q.revision,
        position: q.position,
        assignee: q.assignee_user_id,
        escalated: q.escalated_at !== null,
        planning: q.planning_session_id !== null,
      })),
      spec: current ? toSpec(current) : null,
      previousSpec: previous ? toSpec(previous) : null,
      messages: messages.map((m) => ({
        id: m.id,
        author: m.author_kind,
        authorId: m.author_id,
        authorName:
          m.author_kind === "agent" ? "Planning agent" : (people.get(m.author_id) ?? m.author_id),
        text: m.text,
        questionId: m.question_id,
        replyTo: m.reply_to,
        kind: m.kind,
        deliveredAt: m.delivered_at,
        createdAt: m.created_at,
        pin: m.pin ? parseJson<z.output<typeof pinSchema> | null>(m.pin, null) : null,
        anchor: m.anchor
          ? parseJson<{ specId: string; lineStart: number; lineEnd: number; quote: string }>(
              m.anchor,
              { specId: "", lineStart: 0, lineEnd: 0, quote: "" },
            )
          : null,
      })),
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        description: a.description,
        revision: a.revision,
        keep: a.keep === 1,
        controls: parseJson<string[]>(a.controls, []),
        size: a.size,
        updatedAt: a.updated_at,
        designType: a.design_type,
        pulledPath: a.pulled_path,
      })),
      edits: edits.map((e) => ({
        kept: !notKept.has(e.id),
        whyNotKept: current && notKept.has(e.id) ? whyNotKept(current.body_md, e.footprint) : null,
        mentions: current ? mentions(current.body_md, e.footprint) : [],
        blocks: e.footprint.blocks.map((b) => ({ ...b, parent: b.parent ?? "" })),
        id: e.id,
        specId: e.spec_id,
        lineStart: e.line_start,
        lineEnd: e.line_end,
        before: e.before,
        after: e.after,
        authorId: e.author_id,
        authorName: people.get(e.author_id) ?? e.author_id,
        createdAt: e.created_at,
      })),
      present,
    };
  },
});

/** Names edits for a refusal: each edit's words (or what it removed), its section and its author. */
async function describeEdits(
  ctx: HandlerContext,
  edits: {
    after: string;
    before: string;
    author_id: string;
    footprint: EditFootprint;
  }[],
  md: string,
): Promise<string> {
  const ids = [...new Set(edits.map((e) => e.author_id))];
  const names = new Map<string, string>();
  for (const u of await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "github_login"])
    .where("id", "in", ids)
    .execute())
    names.set(u.id, u.name || u.github_login || u.id);
  return edits
    .map((e) => {
      const section = (e.footprint.blocks[0] ?? e.footprint.gone[0])?.section;
      const what = e.after.trim()
        ? JSON.stringify(e.after.trim())
        : `removing ${JSON.stringify(e.before.trim())}`;
      return `${what}${section ? ` (in ${section})` : ""} by ${names.get(e.author_id) ?? e.author_id}: ${whyNotKept(md, e.footprint)}`;
    })
    .join("; ");
}

type Critique = {
  status: "done" | "timed_out" | "failed";
  notes: string[];
  summary: string | null;
  at: string;
};

/** A stored critique, read defensively. */
function critiqueOf(raw: string): Critique | null {
  const c = parseJson<Partial<Critique>>(raw, {});
  if (!c.at) return null;
  return {
    status: c.status === "timed_out" || c.status === "failed" ? c.status : "done",
    notes: Array.isArray(c.notes) ? c.notes.map(String) : [],
    summary: typeof c.summary === "string" ? c.summary : null,
    at: c.at,
  };
}

export const specCritique = defineOperation({
  name: "spec.critique",
  description:
    "The Workflow records the spec critic's notes on the plan version going to the gate (spec 23 part C): a review-role run read the spec and the repository. The notes are shown at the spec gate and delivered to the planning session as news. They are notes only: they can't approve, reject or open the gate, whatever they say; a person decides the gate as always. `status` says whether the critic finished, timed out or failed.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    specId: z.string().min(1),
    status: z.enum(["done", "timed_out", "failed"]),
    notes: z.array(z.string().min(1).max(1_000)).max(20),
    summary: z.string().max(2_000).nullable(),
  }),
  output: z.object({ specId: z.string(), notes: z.number() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const spec = await ctx.db
      .selectFrom("core_specs")
      .select(["id", "work_item_id"])
      .where("id", "=", input.specId)
      .executeTakeFirst();
    if (spec?.work_item_id !== w.id) throw new OperationError("not_found", "no such plan version");
    const critique: Critique = {
      status: input.status,
      notes: input.notes,
      summary: input.summary,
      at: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_specs")
        .set({ critique: JSON.stringify(critique) })
        .where("id", "=", spec.id),
    );
    // The planner hears notes; a critic that timed out or failed with none is only recorded.
    if (input.notes.length) {
      logPlanning(ctx, w.id, "spec.critiqued", {
        specId: spec.id,
        status: input.status,
        notes: input.notes,
        summary: input.summary,
      });
    }
    ctx.change({
      entity: "spec",
      id: spec.id,
      after: { critique: input.status, notes: input.notes.length },
    });
    return { specId: spec.id, notes: input.notes.length };
  },
});

export const planningRequestYield = defineOperation({
  name: "planning.requestYield",
  description:
    "The Workflow asks a work item's planning session, waiting at the spec gate, to give up its runner slot and the item's lease (spec 23 part C): the spec critic's run needs them. The planner yields at its next wait (`yield: true`), and the next news resumes the same conversation. A session that isn't open, or already yielded, is left as it is.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ requested: z.boolean() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const session = await openSession(ctx, w.id);
    if (!session || session.status === "yielded" || session.yield_requested_at) {
      return { requested: false };
    }
    ctx.write(
      ctx.db
        .updateTable("core_planning_sessions")
        .set({ yield_requested_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", session.id),
    );
    return { requested: true };
  },
});
