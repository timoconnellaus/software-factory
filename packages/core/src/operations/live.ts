// Watching and steering a run from the dashboard (spec 31, ADR 0400). `run.live` reads a run's
// events for the work item page; `run.steer` queues a person's message into the live session, for
// the owner of the run's runner only (typing runs code on their machine with their model credential,
// ADR 0023, 0038); `run.takeSteers` is how the runner host takes them over the signed channel.
import { type CapabilityManifest, STEER_MAX, steerText } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { logPlanning, takeBackFromGate } from "../planning.ts";
import { fencingToken, jobId, requireWorkItem, workItemId } from "./shared.ts";

/** Runs whose session may still be steered (core_runs.status). */
const ACTIVE = ["claimed", "preparing", "running", "collecting"];
/** Most events one `run.live` answer carries. */
export const LIVE_EVENTS_MAX = 300;
/** Most payload characters one `run.live` answer carries (terminal screens are the big ones). */
export const LIVE_BYTES_MAX = 300_000;

/** The run of events that fits the budget, keeping the newest or the oldest end (at least one). */
function withinBudget<T extends { payload: string }>(rows: T[], keep: "newest" | "oldest"): T[] {
  let total = 0;
  const ordered = keep === "newest" ? [...rows].reverse() : rows;
  const kept: T[] = [];
  for (const row of ordered) {
    total += row.payload.length;
    if (kept.length > 0 && total > LIVE_BYTES_MAX) break;
    kept.push(row);
  }
  return keep === "newest" ? kept.reverse() : kept;
}

const runId = z.string().regex(/^run_[0-9a-f]{32}$/, "a run id (run_…)");

const steerView = z.object({
  id: z.string(),
  text: z.string(),
  at: z.string(),
  /** Who sent it: "you" in the app when it is the viewer. */
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  /** `undelivered`: the run ended before the host took it. */
  status: z.enum(["queued", "delivered", "undelivered"]),
  deliveredAt: z.string().nullable(),
});

const eventView = z.object({
  seq: z.number(),
  at: z.string(),
  type: z.string(),
  /** The event's own fields (runner-contract `runnerEventSchema`, minus job, seq and time). */
  data: z.record(z.string(), z.unknown()),
});

async function loadRunForItem(ctx: HandlerContext, workItem: string, id?: string) {
  let q = ctx.db
    .selectFrom("core_runs")
    .leftJoin("core_runners", "core_runners.id", "core_runs.runner_id")
    .select([
      "core_runs.id",
      "core_runs.job_id",
      "core_runs.run_no",
      "core_runs.stage",
      "core_runs.status",
      "core_runs.outcome",
      "core_runs.runner_id",
      "core_runs.started_at",
      "core_runs.ended_at",
      "core_runs.takeover",
      "core_runners.name as runner_name",
      "core_runners.owner_user_id as runner_owner",
      "core_runners.manifest as runner_manifest",
    ])
    .where("core_runs.work_item_id", "=", workItem);
  q = id ? q.where("core_runs.id", "=", id) : q.orderBy("core_runs.run_no", "desc");
  return q.executeTakeFirst();
}
type LiveRun = NonNullable<Awaited<ReturnType<typeof loadRunForItem>>>;

function canSteer(run: LiveRun, viewer: string): { allowed: boolean; reason: string | null } {
  if (run.runner_owner !== viewer) {
    return {
      allowed: false,
      reason: "Only the runner's owner can message the agent: it runs on their machine.",
    };
  }
  if (!ACTIVE.includes(run.status)) return { allowed: false, reason: "The run has ended." };
  let manifest: CapabilityManifest | null = null;
  try {
    manifest = run.runner_manifest ? (JSON.parse(run.runner_manifest) as CapabilityManifest) : null;
  } catch {
    manifest = null;
  }
  if (!manifest?.capabilities.includes("steer")) {
    return { allowed: false, reason: "This runner can't take messages: update it to steer." };
  }
  return { allowed: true, reason: null };
}

export const runLive = defineOperation({
  name: "run.live",
  description:
    "A run's live view for the work item page (spec 31): the run (the one named, else the latest), its events after `afterSeq` (the newest 300 without it, at most 300 with it: agent messages, tool calls, status changes, terminal output), the messages people sent it, and whether the viewer may send one. Read-only; any member of the org may watch.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({
    workItemId,
    runId: runId.optional(),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  output: z.object({
    run: z
      .object({
        id: z.string(),
        jobId: z.string(),
        runNo: z.number(),
        stage: z.string(),
        status: z.string(),
        outcome: z.string().nullable(),
        active: z.boolean(),
        runnerId: z.string(),
        runnerName: z.string().nullable(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
        takeover: z.object({ label: z.string(), hint: z.string() }).nullable(),
      })
      .nullable(),
    events: z.array(eventView),
    /** The last seq in this answer (or `afterSeq` when none is new), for the next `afterSeq`. */
    lastSeq: z.number(),
    /** Whether events before the first one returned were left out. */
    truncated: z.boolean(),
    steers: z.array(steerView),
    steer: z.object({ allowed: z.boolean(), reason: z.string().nullable(), max: z.number() }),
  }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) {
      if (input.runId) throw new OperationError("not_found", "no such run on this work item");
      return {
        run: null,
        events: [],
        lastSeq: 0,
        truncated: false,
        steers: [],
        steer: { allowed: false, reason: "No run yet.", max: STEER_MAX },
      };
    }
    const [rows, steers] = await Promise.all([
      input.afterSeq === undefined
        ? ctx.db
            .selectFrom("core_run_events")
            .select(["seq", "at", "type", "payload"])
            .where("run_id", "=", run.id)
            .orderBy("seq", "desc")
            .limit(LIVE_EVENTS_MAX)
            .execute()
            .then((rows) => rows.reverse())
        : ctx.db
            .selectFrom("core_run_events")
            .select(["seq", "at", "type", "payload"])
            .where("run_id", "=", run.id)
            .where("seq", ">", input.afterSeq)
            .orderBy("seq", "asc")
            .limit(LIVE_EVENTS_MAX)
            .execute(),
      ctx.db
        .selectFrom("core_run_steers")
        .leftJoin("core_user", "core_user.id", "core_run_steers.author_user_id")
        .select([
          "core_run_steers.id",
          "core_run_steers.text",
          "core_run_steers.created_at",
          "core_run_steers.delivered_at",
          "core_run_steers.author_user_id",
          "core_user.name as author_name",
          "core_user.github_login as author_login",
        ])
        .where("core_run_steers.run_id", "=", run.id)
        .orderBy("core_run_steers.created_at", "asc")
        .limit(200)
        .execute(),
    ]);
    const active = ACTIVE.includes(run.status);
    // At most LIVE_BYTES_MAX of payload: the newest events for a first read, the oldest new ones
    // after a cursor (the next poll carries on from the last one returned).
    const events = withinBudget(rows, input.afterSeq === undefined ? "newest" : "oldest");
    const lastSeq = events.at(-1)?.seq ?? input.afterSeq ?? 0;
    const first = events[0]?.seq;
    return {
      run: {
        id: run.id,
        jobId: run.job_id,
        runNo: run.run_no,
        stage: run.stage,
        status: run.status,
        outcome: run.outcome,
        active,
        runnerId: run.runner_id,
        runnerName: run.runner_name ?? null,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        takeover: parseTakeover(run.takeover),
      },
      events: events.map((e) => ({
        seq: e.seq,
        at: e.at,
        type: e.type,
        data: parsePayload(e.payload),
      })),
      lastSeq,
      truncated: first !== undefined && first > (input.afterSeq ?? 0) + 1,
      steers: steers.map((s) => ({
        id: s.id,
        text: s.text,
        at: s.created_at,
        authorUserId: s.author_user_id,
        authorName: s.author_login ?? s.author_name ?? null,
        status: (s.delivered_at ? "delivered" : active ? "queued" : "undelivered") as
          | "queued"
          | "delivered"
          | "undelivered",
        deliveredAt: s.delivered_at,
      })),
      steer: { ...canSteer(run, ctx.actor.id), max: STEER_MAX },
    };
  },
});

function parsePayload(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = parsed as Record<string, unknown>;
      // Older rows and other runners may carry longer text; the view never needs more.
      if (typeof out.text === "string" && out.text.length > 64_000) {
        out.text = out.text.slice(-64_000);
      }
      return out;
    }
  } catch {
    // A row we can't read is shown as empty rather than failing the view.
  }
  return {};
}

function parseTakeover(text: string | null): { label: string; hint: string } | null {
  if (!text) return null;
  try {
    const t = JSON.parse(text) as { label?: unknown; hint?: unknown };
    return typeof t.label === "string" && typeof t.hint === "string"
      ? { label: t.label, hint: t.hint }
      : null;
  } catch {
    return null;
  }
}

export const runSteer = defineOperation({
  name: "run.steer",
  description:
    "Send a message into a live run's agent session (spec 31, ADR 0400), as if typed at its terminal. Only the owner of the run's runner may: it runs on their machine with their model credential. The text is sanitised, made one line and capped at 2,000 characters; the runner host takes it over the signed channel within seconds. Refused for an ended run or a runner that can't take messages.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({
    workItemId,
    runId,
    // Generous before sanitising: the stored text is capped at STEER_MAX.
    text: z
      .string()
      .min(1)
      .max(STEER_MAX * 4),
  }),
  output: z.object({ steerId: z.string(), text: z.string(), status: z.literal("queued") }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) throw new OperationError("not_found", "no such run on this work item");
    const verdict = canSteer(run, ctx.actor.id);
    if (!verdict.allowed) {
      const code =
        run.runner_owner !== ctx.actor.id
          ? "forbidden"
          : !ACTIVE.includes(run.status)
            ? "conflict"
            : "unavailable";
      throw new OperationError(code, verdict.reason ?? "can't steer this run");
    }
    const text = steerText(input.text);
    if (!text) throw new OperationError("invalid_input", "the message is empty once cleaned");
    const id = newId("runSteer");
    ctx.write(
      ctx.db.insertInto("core_run_steers").values({
        id,
        run_id: run.id,
        work_item_id: item.id,
        author_user_id: ctx.actor.id,
        text,
        created_at: ctx.now,
        delivered_at: null,
      }),
    );
    ctx.change({ entity: "run_steer", id, after: { runId: run.id, text } });
    // A steer on a planning run is part of the planning record (ADR 0470): the chat shows it and a
    // session rebuilt on another runner reads it. It reaches the agent as typed, so it is logged as
    // `chat.steered`, which isn't news, and marked read when the runner host takes the steer. Like
    // any person's word, it takes the spec back from the gate.
    if (run.stage === "planning") {
      const messageId = newId("planningMessage");
      ctx.write(
        ctx.db.insertInto("core_planning_messages").values({
          id: messageId,
          work_item_id: item.id,
          author_kind: "person",
          author_id: ctx.actor.id,
          text,
          steer_id: id,
          created_at: ctx.now,
        }),
      );
      logPlanning(ctx, item.id, "chat.steered", { messageId, steerId: id });
      await takeBackFromGate(ctx, item, "a person steered the planner");
    }
    // Wakes the runner host's held steer call (sf-engine: the work item's hub).
    ctx.emit({ kind: "run.steered", payload: { workItemId: item.id } });
    return { steerId: id, text, status: "queued" as const };
  },
});

export const runTakeSteers = defineOperation({
  name: "run.takeSteers",
  description:
    "The runner host takes a running job's queued steers, oldest first, and they are marked delivered (at most once, ADR 0400). sf-engine's channel holds the call while none are queued. Fenced: a stale token is refused.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken }),
  output: z.object({
    workItemId: z.string(),
    steers: z.array(z.object({ id: z.string(), text: z.string(), at: z.string() })),
  }),
  async handler(input, ctx) {
    const run = await ctx.db
      .selectFrom("core_runs")
      .select(["id", "runner_id", "status", "work_item_id"])
      .where("job_id", "=", input.jobId)
      .executeTakeFirst();
    if (!run) throw new OperationError("not_found", `no run for job ${input.jobId}`);
    if (run.runner_id !== ctx.actor.id) {
      throw new OperationError("forbidden", "this job belongs to another runner");
    }
    if (!ACTIVE.includes(run.status)) throw new OperationError("conflict", `run is ${run.status}`);
    const queued = await ctx.db
      .selectFrom("core_run_steers")
      .select(["id", "text", "created_at"])
      .where("run_id", "=", run.id)
      .where("delivered_at", "is", null)
      .orderBy("created_at", "asc")
      .limit(20)
      .execute();
    if (queued.length > 0) {
      ctx.write(
        ctx.db
          .updateTable("core_run_steers")
          .set({ delivered_at: ctx.now })
          .where(
            "id",
            "in",
            queued.map((s) => s.id),
          )
          .where("delivered_at", "is", null),
      );
      // A steer typed into a planning session is its chat message's delivery (spec 26).
      ctx.write(
        ctx.db
          .updateTable("core_planning_messages")
          .set({ delivered_at: ctx.now })
          .where(
            "steer_id",
            "in",
            queued.map((s) => s.id),
          )
          .where("delivered_at", "is", null),
      );
    }
    return {
      workItemId: run.work_item_id,
      steers: queued.map((s) => ({ id: s.id, text: s.text, at: s.created_at })),
    };
  },
});
