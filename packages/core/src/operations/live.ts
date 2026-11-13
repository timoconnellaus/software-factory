// Watching and steering a run from the dashboard (spec 31, ADR 0400). `run.live` reads a run's
// events for the work item page; `run.steer` queues a person's message into the live session, for
// the owner of the run's runner only (typing runs code on their machine with their model credential,
// ADR 0023, 0038); `run.takeSteers` is how the runner host takes them over the signed channel.
// The web terminal's operations (spec 35, ADR 0440) are in terminal.ts and share the run lookup.
import {
  type Capability,
  type CapabilityManifest,
  STEER_MAX,
  steerText,
} from "@software-factory/runner-contract";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { logPlanning, takeBackFromGate } from "../planning.ts";
import { openArchiveIncident } from "./incidents.ts";
import {
  fencingToken,
  jobId,
  RUN_ARCHIVE_AFTER_DAYS,
  RUN_EVENTS_BATCH_MAX,
  requireWorkItem,
  workItemId,
} from "./shared.ts";

/** Runs whose session may still be steered (core_runs.status). */
export const ACTIVE = ["claimed", "preparing", "running", "collecting"];
/** Most events one `run.live` answer carries. */
export const LIVE_EVENTS_MAX = 300;
/** Most payload characters one `run.live` answer carries (terminal screens are the big ones). */
export const LIVE_BYTES_MAX = 300_000;

/** The run of events that fits the budget, keeping the newest or the oldest end (at least one). */
/** Stored rows as events: a batch row of log lines becomes one `log` event per line. */
function expandRows(
  rows: { seq: number; last_seq: number | null; at: string; type: string; payload: string }[],
): { seq: number; at: string; type: string; payload: string }[] {
  const out: { seq: number; at: string; type: string; payload: string }[] = [];
  for (const row of rows) {
    if (row.last_seq === null) {
      out.push(row);
      continue;
    }
    const { lines } = JSON.parse(row.payload) as { lines: Record<string, unknown>[] };
    for (const { seq, at, ...line } of lines) {
      out.push({
        seq: seq as number,
        at: at as string,
        type: "log",
        payload: JSON.stringify(line),
      });
    }
  }
  return out;
}

type StoredEvent = {
  seq: number;
  last_seq: number | null;
  at: string;
  type: string;
  payload: string;
};

/**
 * What reading the archive came to: `read`; `failed`, R2 couldn't be read (try again); `missing`,
 * the chunk index names an object that isn't there (the run's log is lost: reported as an
 * incident, never shown as an empty run).
 */
type ArchiveRead = "read" | "failed" | "missing";

/** One archived chunk's rows (NDJSON in sf-archive), and whether it could be read. */
async function readChunk<T>(
  ctx: HandlerContext,
  key: string,
): Promise<{ rows: T[]; state: ArchiveRead }> {
  const archive = ctx.services.runArchive;
  if (!archive) return { rows: [], state: "failed" };
  let text: string | null;
  try {
    text = await archive.get(key);
  } catch {
    return { rows: [], state: "failed" };
  }
  if (text === null) return { rows: [], state: "missing" };
  return {
    rows: text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T),
    state: "read",
  };
}

const DAY = 86_400_000;

/**
 * A page of a run's events, from D1, the archive or both (AGENTS.md "Cloudflare cost", rule 3).
 * A run still live, or ended under 29 days ago, is read from D1 alone. Otherwise the run may be
 * archived, wholly (marked) or part-way (its oldest chunks moved, the rest still in D1): D1 is read
 * first, then the chunk index, so a chunk archived between the two reads is found by the second
 * and nothing is skipped; a chunk after the cursor is served before D1 (it holds the older seqs),
 * one chunk a page, and the next poll carries on from its end, so nothing is read twice.
 */
async function pageEvents(
  ctx: HandlerContext,
  run: LiveRun,
  afterSeq: number | undefined,
): Promise<{ rows: Event[]; archive: ArchiveRead | null; missingSeq?: number }> {
  const mayBeArchived =
    run.events_archived_at !== null ||
    (run.ended_at !== null &&
      Date.parse(run.ended_at) < Date.parse(ctx.now) - (RUN_ARCHIVE_AFTER_DAYS - 1) * DAY);
  if (!mayBeArchived) return { rows: await liveRows(ctx, run.id, afterSeq), archive: null };
  const d1 = run.events_archived_at === null ? await liveRows(ctx, run.id, afterSeq) : [];
  // The newest page: D1 holds the newest events while it holds any.
  if (afterSeq === undefined && d1.length > 0) return { rows: d1, archive: null };
  let q = ctx.db
    .selectFrom("core_run_archive_chunks")
    .select(["r2_key", "first_seq"])
    .where("run_id", "=", run.id)
    .where("first_seq", ">=", 0);
  q =
    afterSeq === undefined
      ? q.orderBy("first_seq", "desc")
      : q.where("last_seq", ">", afterSeq).orderBy("first_seq", "asc");
  const chunk = await q.limit(1).executeTakeFirst();
  if (!chunk) return { rows: d1, archive: null };
  const { rows, state } = await readChunk<StoredEvent>(ctx, chunk.r2_key);
  if (state === "missing") return { rows: [], archive: state, missingSeq: chunk.first_seq };
  if (state !== "read") return { rows: [], archive: state };
  const events = expandRows(rows);
  return {
    rows:
      afterSeq === undefined
        ? events.slice(-LIVE_EVENTS_MAX)
        : events.filter((e) => e.seq > afterSeq).slice(0, LIVE_EVENTS_MAX),
    archive: "read",
  };
}

type Event = { seq: number; at: string; type: string; payload: string };

/** An archived run's steers (its one steers object), with their authors' names. */
async function archivedSteers(ctx: HandlerContext, runIdValue: string) {
  const chunk = await ctx.db
    .selectFrom("core_run_archive_chunks")
    .select("r2_key")
    .where("run_id", "=", runIdValue)
    .where("first_seq", "=", -1)
    .executeTakeFirst();
  const { rows: steers, state } = chunk
    ? await readChunk<{
        id: string;
        text: string;
        created_at: string;
        delivered_at: string | null;
        author_user_id: string;
        kind: string;
      }>(ctx, chunk.r2_key)
    : { rows: [], state: "read" as const };
  const ids = [...new Set(steers.map((s) => s.author_user_id))];
  const users = ids.length
    ? await ctx.db
        .selectFrom("core_user")
        .select(["id", "name", "github_login"])
        .where("id", "in", ids)
        .execute()
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    state,
    steers: steers.slice(0, 200).map((s) => ({
      ...s,
      author_name: byId.get(s.author_user_id)?.name ?? null,
      author_login: byId.get(s.author_user_id)?.github_login ?? null,
    })),
  };
}

/** Stored rows read per query: a row is at most ~64 KB, so a page is at most ~1.3 MB. */
const LIVE_PAGE_ROWS = 20;

/**
 * A run's events for run.live, read from D1 a page of rows at a time until the answer has
 * LIVE_EVENTS_MAX events or LIVE_BYTES_MAX bytes: bounded by lines and bytes, not by rows (a row
 * may hold a batch of up to 200 lines). Newest first for a first read, else after the cursor.
 */
async function liveRows(
  ctx: HandlerContext,
  runIdValue: string,
  afterSeq: number | undefined,
): Promise<{ seq: number; at: string; type: string; payload: string }[]> {
  const out: { seq: number; at: string; type: string; payload: string }[] = [];
  let bytes = 0;
  const full = () => out.length >= LIVE_EVENTS_MAX || bytes >= LIVE_BYTES_MAX;
  if (afterSeq === undefined) {
    let below: number | null = null;
    while (!full()) {
      let q = ctx.db
        .selectFrom("core_run_events")
        .select(["seq", "last_seq", "at", "type", "payload"])
        .where("run_id", "=", runIdValue);
      if (below !== null) q = q.where("seq", "<", below);
      const page = await q.orderBy("seq", "desc").limit(LIVE_PAGE_ROWS).execute();
      for (const row of page) bytes += row.payload.length;
      below = page.at(-1)?.seq ?? null;
      out.unshift(...expandRows(page.reverse()));
      if (page.length < LIVE_PAGE_ROWS) break;
    }
    return out.slice(-LIVE_EVENTS_MAX);
  }
  // A batch row starts at most a batch before the lines it holds: the seq bound keeps the read on
  // the primary key, the coalesce catches a batch straddling the cursor.
  let from = afterSeq - RUN_EVENTS_BATCH_MAX;
  while (!full()) {
    const page = await ctx.db
      .selectFrom("core_run_events")
      .select(["seq", "last_seq", "at", "type", "payload"])
      .where("run_id", "=", runIdValue)
      .where("seq", ">", from)
      .where(sql<boolean>`coalesce(last_seq, seq) > ${afterSeq}`)
      .orderBy("seq", "asc")
      .limit(LIVE_PAGE_ROWS)
      .execute();
    for (const row of page) bytes += row.payload.length;
    out.push(...expandRows(page).filter((e) => e.seq > afterSeq));
    if (page.length < LIVE_PAGE_ROWS) break;
    from = page.at(-1)?.seq ?? from;
  }
  return out.slice(0, LIVE_EVENTS_MAX);
}

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

export const runId = z.string().regex(/^run_[0-9a-f]{32}$/, "a run id (run_…)");

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
  /** `takeover`: a request to stop the stream session for a person (ADR 0450), no text. */
  kind: z.enum(["message", "takeover"]),
});

const eventView = z.object({
  seq: z.number(),
  at: z.string(),
  type: z.string(),
  /** The event's own fields (runner-contract `runnerEventSchema`, minus job, seq and time). */
  data: z.record(z.string(), z.unknown()),
});

export async function loadRunForItem(ctx: HandlerContext, workItem: string, id?: string) {
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
      "core_runs.events_archived_at",
      "core_runs.session_mode",
      "core_runs.takeover",
      "core_runners.name as runner_name",
      "core_runners.owner_user_id as runner_owner",
      "core_runners.manifest as runner_manifest",
    ])
    .where("core_runs.work_item_id", "=", workItem);
  q = id ? q.where("core_runs.id", "=", id) : q.orderBy("core_runs.run_no", "desc");
  return q.executeTakeFirst();
}
export type LiveRun = NonNullable<Awaited<ReturnType<typeof loadRunForItem>>>;

/** Whether the run's runner declared a capability in its last manifest. */
export function runnerHas(run: LiveRun, capability: Capability): boolean {
  let manifest: CapabilityManifest | null = null;
  try {
    manifest = run.runner_manifest ? (JSON.parse(run.runner_manifest) as CapabilityManifest) : null;
  } catch {
    manifest = null;
  }
  return !!manifest?.capabilities.includes(capability);
}

/**
 * Whether the viewer may open the run's web terminal (ADR 0440), and in which mode: `type` for the
 * owner of the run's runner, `watch` for everyone else who can read the work item.
 */
export function terminalVerdict(
  run: LiveRun,
  viewer: string,
): { allowed: boolean; mode: "type" | "watch" | null; reason: string | null } {
  if (!ACTIVE.includes(run.status)) {
    return { allowed: false, mode: null, reason: "The run has ended." };
  }
  if (!runnerHas(run, "terminal")) {
    return {
      allowed: false,
      mode: null,
      reason: "This runner can't share its terminal: update it to use the web terminal.",
    };
  }
  return run.runner_owner === viewer
    ? { allowed: true, mode: "type", reason: null }
    : {
        allowed: true,
        mode: "watch",
        reason: "Only the runner's owner can type: it runs on their machine.",
      };
}

function runnerManifest(run: LiveRun): CapabilityManifest | null {
  try {
    return run.runner_manifest ? (JSON.parse(run.runner_manifest) as CapabilityManifest) : null;
  } catch {
    return null;
  }
}

function canSteer(run: LiveRun, viewer: string): { allowed: boolean; reason: string | null } {
  if (run.runner_owner !== viewer) {
    return {
      allowed: false,
      reason: "Only the runner's owner can message the agent: it runs on their machine.",
    };
  }
  if (!ACTIVE.includes(run.status)) return { allowed: false, reason: "The run has ended." };
  if (!runnerHas(run, "steer")) {
    return { allowed: false, reason: "This runner can't take messages: update it to steer." };
  }
  return { allowed: true, reason: null };
}

/**
 * How the run's session runs (ADR 0450): kept on the run from its `session.started` (migration
 * 0362), so an archived run still knows; read from the event for a run from before that column,
 * while its events are still in D1. Null before the session starts.
 */
async function sessionMode(
  ctx: HandlerContext,
  run: Pick<LiveRun, "id" | "session_mode" | "events_archived_at">,
): Promise<"terminal" | "stream" | null> {
  if (run.session_mode) return run.session_mode;
  if (run.events_archived_at !== null) return null;
  const row = await ctx.db
    .selectFrom("core_run_events")
    .select("payload")
    .where("run_id", "=", run.id)
    .where("type", "=", "session.started")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const mode = parsePayload(row.payload).mode;
  return mode === "stream" ? "stream" : "terminal";
}

/** Whether a run has a takeover request queued or taken (ADR 0450). */
async function takeoverRequested(ctx: HandlerContext, runId: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("core_run_steers")
    .select("id")
    .where("run_id", "=", runId)
    .where("kind", "=", "takeover")
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

type TakeoverVerdict = {
  allowed: boolean;
  reason: string | null;
  code: "forbidden" | "conflict" | "unavailable" | null;
};

/** Whether the viewer may take the run's stream session over by resume (ADR 0450). */
function canTakeOver(
  run: LiveRun,
  viewer: string,
  mode: "terminal" | "stream" | null,
  requested: boolean,
): TakeoverVerdict {
  if (run.runner_owner !== viewer) {
    return {
      allowed: false,
      code: "forbidden",
      reason: "Only the runner's owner can take the session over: it runs on their machine.",
    };
  }
  if (!ACTIVE.includes(run.status)) {
    return { allowed: false, code: "conflict", reason: "The run has ended." };
  }
  if (requested) {
    return { allowed: false, code: "conflict", reason: "The session is already being taken over." };
  }
  if (mode !== "stream" || !runnerManifest(run)?.capabilities.includes("chat")) {
    return {
      allowed: false,
      code: "unavailable",
      reason:
        mode === "terminal"
          ? "This run is in a terminal: attach to it on the runner instead."
          : "This run's session can't be taken over from here.",
    };
  }
  return { allowed: true, code: null, reason: null };
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
        /**
         * How its session runs (ADR 0450): `stream` is shown as a chat. Null before the session
         * has started.
         */
        mode: z.enum(["terminal", "stream"]).nullable(),
      })
      .nullable(),
    events: z.array(eventView),
    /**
     * The run's events were moved to the archive (30 days after it ended): they are read from
     * there, a page at a time, and the view says so.
     */
    archived: z.boolean().optional(),
    /**
     * Whether this answer read the archive, and how that went: `read`; `failed`, R2 couldn't be
     * read (try again); `missing`, an object the chunk index names isn't there (the log is lost:
     * the view says so and it is reported as an incident). Null when the answer came from D1 only.
     */
    archive: z.enum(["read", "failed", "missing"]).nullable().optional(),
    /**
     * When `missing`: which chunk (its first seq, -1 for the steers) for run.reportArchiveMissing,
     * and the incident once one is open (one per run).
     */
    archiveMissing: z
      .object({
        firstSeq: z.number(),
        incident: z.object({ workItemId: z.string(), number: z.number() }).nullable(),
      })
      .nullable()
      .optional(),
    /** The last seq in this answer (or `afterSeq` when none is new), for the next `afterSeq`. */
    lastSeq: z.number(),
    /** Whether events before the first one returned were left out. */
    truncated: z.boolean(),
    steers: z.array(steerView),
    steer: z.object({ allowed: z.boolean(), reason: z.string().nullable(), max: z.number() }),
    /** Whether the viewer may take a stream session over by resume (ADR 0450). */
    takeover: z.object({
      allowed: z.boolean(),
      reason: z.string().nullable(),
      /** A takeover was asked for (queued or taken by the host). */
      requested: z.boolean(),
    }),
    /** Whether the viewer may open the run's web terminal, and whether they could type (ADR 0440). */
    terminal: z.object({
      allowed: z.boolean(),
      mode: z.enum(["type", "watch"]).nullable(),
      reason: z.string().nullable(),
    }),
  }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) {
      if (input.runId) throw new OperationError("not_found", "no such run on this work item");
      return {
        run: null,
        events: [],
        archived: false,
        lastSeq: 0,
        truncated: false,
        steers: [],
        steer: { allowed: false, reason: "No run yet.", max: STEER_MAX },
        takeover: { allowed: false, reason: "No run yet.", requested: false },
        terminal: { allowed: false, mode: null, reason: "No run yet." },
      };
    }
    const afterSeq = input.afterSeq;
    const archived = run.events_archived_at !== null;
    const [page, steerRead, mode] = await Promise.all([
      pageEvents(ctx, run, afterSeq),
      archived
        ? archivedSteers(ctx, run.id)
        : ctx.db
            .selectFrom("core_run_steers")
            .leftJoin("core_user", "core_user.id", "core_run_steers.author_user_id")
            .select([
              "core_run_steers.id",
              "core_run_steers.text",
              "core_run_steers.created_at",
              "core_run_steers.delivered_at",
              "core_run_steers.author_user_id",
              "core_run_steers.kind",
              "core_user.name as author_name",
              "core_user.github_login as author_login",
            ])
            .where("core_run_steers.run_id", "=", run.id)
            .orderBy("core_run_steers.created_at", "asc")
            .limit(200)
            .execute()
            .then((steers) => ({ steers, state: "read" as ArchiveRead })),
      sessionMode(ctx, run),
    ]);
    const rows = page.rows;
    const steers = steerRead.steers;
    // The worst of the two reads: a lost or unreadable object is never shown as an empty run.
    const archive: ArchiveRead | null =
      page.archive === "missing" || steerRead.state === "missing"
        ? "missing"
        : page.archive === "failed" || steerRead.state === "failed"
          ? "failed"
          : (page.archive ?? (archived ? "read" : null));
    // Only when something is missing (rare): the run's incident, on core_incidents_run_idx.
    const archiveMissing =
      archive === "missing"
        ? {
            firstSeq: page.archive === "missing" ? (page.missingSeq ?? 0) : -1,
            incident: await archiveIncident(ctx, run.id),
          }
        : null;
    const requested = steers.some((s) => s.kind === "takeover");
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
        mode,
      },
      archived,
      archive,
      archiveMissing,
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
        kind: s.kind === "takeover" ? ("takeover" as const) : ("message" as const),
      })),
      steer: { ...canSteer(run, ctx.actor.id), max: STEER_MAX },
      takeover: (({ allowed, reason }) => ({ allowed, reason, requested }))(
        canTakeOver(run, ctx.actor.id, mode, requested),
      ),
      terminal: terminalVerdict(run, ctx.actor.id),
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
    // Wakes the host through its job line, when it keeps one (spec 44 part B): routed to the job's
    // relay. A host without a line finds the steer on its held call's next poll.
    ctx.emit({ kind: "run.steered", payload: { workItemId: item.id, jobId: run.job_id } });
    return { steerId: id, text, status: "queued" as const };
  },
});

export const runTakeSteers = defineOperation({
  name: "run.takeSteers",
  description:
    "The runner host takes a running job's queued steers, oldest first, and they are marked delivered (at most once, ADR 0400). sf-engine's channel holds the call while none are queued, polling for one in the Worker (spec 44). Fenced: a stale token is refused.",
  risk: "write",
  // Re-taken every 25 s per running job: audited only when it hands steers over (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.steers.length > 0 },
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken }),
  output: z.object({
    workItemId: z.string(),
    /** The job's run: what the channel's held call polls for queued steers (spec 44). */
    runId: z.string(),
    steers: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        at: z.string(),
        interrupt: z.boolean().optional(),
        kind: z.enum(["message", "takeover"]),
      }),
    ),
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
      .select(["id", "text", "created_at", "interrupt"])
      .select(["id", "text", "created_at", "kind"])
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
      // Every steer this call read is the one it marks delivered, or the batch aborts: two takes
      // racing can't both hand the same steer over (the loser answers 409 conflict, and the
      // channel's held call keeps waiting).
      ctx.guardExists(
        "steers taken once",
        ctx.db
          .selectNoFrom(sql<number>`1`.as("one"))
          .where(sql<boolean>`changes() = ${queued.length}`),
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
      runId: run.id,
      steers: queued.map((s) => ({
        id: s.id,
        text: s.text,
        at: s.created_at,
        // ADR 0470: a planning interrupt stops the current step before its fixed line.
        ...(s.interrupt ? { interrupt: true } : {}),
        kind: s.kind === "takeover" ? ("takeover" as const) : ("message" as const),
      })),
    };
  },
});

export const runTakeover = defineOperation({
  name: "run.takeover",
  description:
    "Take a live run's stream-json session over in a terminal (spec 37, ADR 0450): the runner host stops the session cleanly and the run then shows the exact `claude --resume <session-id>` command to run on that machine. The job keeps its worktree and lease; quitting the resumed session hands the run back as usual. Only the owner of the run's runner may, once per run, and only for a stream session on a runner with `chat`.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, runId }),
  output: z.object({ requestId: z.string(), status: z.literal("queued") }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) throw new OperationError("not_found", "no such run on this work item");
    const [mode, requested] = await Promise.all([
      sessionMode(ctx, run),
      takeoverRequested(ctx, run.id),
    ]);
    const verdict = canTakeOver(run, ctx.actor.id, mode, requested);
    if (!verdict.allowed) {
      throw new OperationError(verdict.code ?? "conflict", verdict.reason ?? "can't take over");
    }
    const id = newId("runSteer");
    ctx.write(
      ctx.db.insertInto("core_run_steers").values({
        id,
        run_id: run.id,
        work_item_id: item.id,
        author_user_id: ctx.actor.id,
        text: "",
        created_at: ctx.now,
        delivered_at: null,
        kind: "takeover",
      }),
    );
    ctx.change({ entity: "run_steer", id, after: { runId: run.id, kind: "takeover" } });
    // Like a steer: pushed down the job line, else found on the held call's next poll (spec 44).
    ctx.emit({ kind: "run.steered", payload: { workItemId: item.id, jobId: run.job_id } });
    return { requestId: id, status: "queued" as const };
  },
});

/** The run's archive incident (one per run), with its work item's number. */
async function archiveIncident(
  ctx: HandlerContext,
  runIdValue: string,
): Promise<{ workItemId: string; number: number } | null> {
  const row = await ctx.db
    .selectFrom("core_incidents")
    .innerJoin("core_work_items", "core_work_items.id", "core_incidents.fix_work_item_id")
    .select(["core_work_items.id", "core_work_items.number"])
    .where("core_incidents.run_id", "=", runIdValue)
    .where("core_incidents.kind", "=", "archive_missing")
    .limit(1)
    .executeTakeFirst();
  return row ? { workItemId: row.id, number: row.number } : null;
}

export const runReportArchiveMissing = defineOperation({
  name: "run.reportArchiveMissing",
  description:
    "Report that part of an archived run's log is missing from the archive (AGENTS.md \"Cloudflare cost\"): run.live answered `archive: missing` for this chunk. Trusts nothing it is told: it finds the chunk in the run's chunk index and checks with R2 (a HEAD) that the object isn't there, and does nothing otherwise. Opens one incident per run, for a person (a work item left in the backlog; no agent runs, since none could bring the object back). The website calls it when a viewer meets the gap; the archive's daily sample calls it as the scheduler.",
  risk: "write",
  actors: ["human", "scheduler"],
  permission: "member",
  input: z.object({ workItemId, runId, firstSeq: z.number().int().min(-1) }),
  output: z.object({
    reported: z.boolean(),
    incident: z.object({ workItemId: z.string(), number: z.number() }).nullable(),
  }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) throw new OperationError("not_found", "no such run on this work item");
    const [chunk, existing] = await Promise.all([
      ctx.db
        .selectFrom("core_run_archive_chunks")
        .select("r2_key")
        .where("run_id", "=", run.id)
        .where("first_seq", "=", input.firstSeq)
        .executeTakeFirst(),
      archiveIncident(ctx, run.id),
    ]);
    if (existing) return { reported: false, incident: existing };
    if (!chunk) return { reported: false, incident: null };
    const archive = ctx.services.runArchive;
    if (!archive) throw new OperationError("unavailable", "the archive isn't bound here");
    if (await archive.exists(chunk.r2_key)) return { reported: false, incident: null };
    const opened = openArchiveIncident(ctx, {
      runId: run.id,
      runNo: run.run_no,
      key: chunk.r2_key,
    });
    return { reported: true, incident: { workItemId: opened.workItemId, number: opened.number } };
  },
});
