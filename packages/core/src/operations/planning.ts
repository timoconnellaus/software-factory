// Planning, the loop (spec 20, ADR 0300, 0350): the planning session's operations. The Workflow
// starts, rounds, notes and ends a session; the planning agent (a runner job) revises the spec,
// chats, reads news, waits, yields and asks for the gate; people chat, report presence, read the
// planning view and move a session to another runner. Questions are in ./questions.ts.
import { json, parseJson } from "@software-factory/db";
import {
  chatReplyInputSchema,
  planningNewsInputSchema,
  planningPeekInputSchema,
  planningReadyInputSchema,
  planningWaitInputSchema,
  specReviseInputSchema,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  batchDue,
  type Delivered,
  enqueuePlanningJob,
  guardNoUnreadPersonNews,
  hasUnreadPersonNews,
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
  takeBackFromGate,
  wakeSession,
  withdrawSpecGate,
} from "../planning.ts";
import { approverIds } from "../scope.ts";
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
        .set({ round, ready_spec_id: null, ready_at: null, at_gate: 0, updated_at: ctx.now })
        .where("id", "=", session.id),
    );
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
        status: "draft",
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ current_spec_id: specId, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
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
    const due = dueAt !== null && dueAt <= Date.parse(ctx.now);
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
      recheckAt: dueAt === null ? null : new Date(dueAt).toISOString(),
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
    "A person writes in the work item's planning chat, optionally about a question or replying to a message. It reaches the planning agent at once and wakes it (resuming a yielded session).",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({
    workItemId,
    text: z.string().trim().min(1).max(20_000),
    questionId: z.string().min(1).optional(),
    replyTo: z.string().min(1).optional(),
  }),
  output: z.object({
    messageId: z.string(),
    /** Set when the message won't reach the planner (the spec was just approved). */
    note: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    await assertAbout(ctx, w.id, input.questionId, input.replyTo);
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
        created_at: ctx.now,
      }),
    );
    logPlanning(ctx, w.id, "chat.message", { messageId });
    const gate = await takeBackFromGate(ctx, w, "a person wrote in the chat");
    await wakeSession(ctx, w);
    return {
      messageId,
      // The spec was approved a moment before this arrived: say so instead of losing it quietly.
      note:
        gate === "decided"
          ? "The spec was approved a moment ago, so the planner won't read this. Tell the approver if it changes anything."
          : null,
    };
  },
});

export const planningPresence = defineOperation({
  name: "planning.presence",
  description:
    "The app reports that the signed-in person has the Planning view open (a heartbeat every ~20 s) or closed it. The planning agent sees who is here in its news.",
  risk: "write",
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
  summary: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const planningGet = defineOperation({
  name: "planning.get",
  description:
    "The Planning view (spec 20): the session (state, runner, whether it waits for its runner), every question with its answer, the current spec and the one before it (to highlight what changed), the chat, who is here, and the log's cursor.",
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
      }),
    ),
    present: z.array(z.object({ userId: z.string(), name: z.string() })),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const [session, questions, specs, messages, last, present] = await Promise.all([
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
    ]);
    const runner = session?.runner_id
      ? await ctx.db
          .selectFrom("core_runners")
          .select(["id", "name", "last_seen_at"])
          .where("id", "=", session.runner_id)
          .executeTakeFirst()
      : undefined;
    const online =
      !!runner?.last_seen_at &&
      Date.parse(ctx.now) - Date.parse(runner.last_seen_at) <= RUNNER_OFFLINE_MS;
    const people = new Map<string, string>();
    const ids = [
      ...new Set(messages.filter((m) => m.author_kind === "person").map((m) => m.author_id)),
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
      summary: s.summary,
      status: s.status,
      createdAt: s.created_at,
      createdBy: s.created_by,
    });
    const current = specs.find((s) => s.id === w.current_spec_id) ?? specs[0];
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
      })),
      present,
    };
  },
});
