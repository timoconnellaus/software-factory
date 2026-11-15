// What a flow run's agent did (spec 70, the run view): the runner's events for the run, normalised
// to three kinds (a note, a tool call, a tool's result), stored in flow_run_events (migration 0434),
// read back in pages, and pruned 30 days after the run finished. Each batch the runner sends is one
// D1 batch: its events and the run's totals (stored count, last seq, steps, tokens), guarded on the
// last seq so a replay or a racing batch stores nothing twice.
import { guardChanged, toStatement } from "@software-factory/db";
import { flowDb, iso, StoreError, writeBatch } from "./db.ts";
import type { RunEventKind } from "./schema.ts";

/** The most events a run keeps; beyond it they are dropped and the run is marked truncated. */
export const RUN_EVENTS_CAP = 2_000;
/** The most characters of any one stored text (a note, a tool's input, a result's output). */
export const RUN_EVENT_TEXT_MAX = 4_000;
/** The most characters of a tool call's label. */
export const RUN_EVENT_LABEL_MAX = 120;
/** The most events `runEvents` returns in one call. */
export const RUN_EVENTS_PAGE = 500;
/** How long a run's events are kept after it finished. */
export const RUN_EVENTS_KEEP_DAYS = 30;
/** The prune: rows a round, and rounds a tick at most. */
export const RUN_EVENTS_PRUNE_BATCH = 500;
export const RUN_EVENTS_PRUNE_ROUNDS = 4;

/**
 * An event as the runner sends it (runner-contract's runnerEventSchema), only the fields this
 * reads. Everything but `message` (the assistant's), `tool`, `tool.result` and `turn` is dropped:
 * logs, status changes, job states and the session's start and end say nothing the run view shows.
 */
export interface ReportedEvent {
  type: string;
  seq: number;
  at: string;
  role?: string;
  text?: string;
  name?: string;
  input?: string;
  id?: string;
  toolId?: string;
  output?: string;
  isError?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/** A stored event as `flow.run.events` returns it. */
export type RunEvent =
  | { seq: number; at: string; kind: "note"; text: string }
  | {
      seq: number;
      at: string;
      kind: "tool";
      name: string;
      label: string;
      input: string;
      toolId: string | null;
    }
  | { seq: number; at: string; kind: "result"; toolId: string; output: string; isError: boolean };

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The part of a path a person recognises: its last three segments. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}

/**
 * A tool call's short label, from its input: what it ran on (a file, a pattern, a URL) or what it
 * says it does (a Bash call's description, else its command). Empty when nothing fits.
 */
export function toolLabel(name: string, input: string | undefined): string {
  if (!input) return "";
  let args: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON (a host may send the raw text): its first line.
  }
  const str = (key: string) => (typeof args?.[key] === "string" ? (args[key] as string) : null);
  let label: string | null;
  if (!args) label = input.split("\n")[0] ?? "";
  else if (name === "Bash") label = str("description") ?? str("command");
  else if (name === "TodoWrite" && Array.isArray(args.todos)) label = `${args.todos.length} todos`;
  else {
    const path = str("file_path") ?? str("notebook_path");
    label =
      (path ? shortPath(path) : null) ??
      str("pattern") ??
      str("description") ??
      str("url") ??
      str("query") ??
      str("path") ??
      str("command") ??
      Object.values(args).find((v): v is string => typeof v === "string") ??
      "";
  }
  return clip((label ?? "").replace(/\s+/g, " ").trim(), RUN_EVENT_LABEL_MAX);
}

type Stored = { seq: number; at: string; kind: RunEventKind; data: Record<string, unknown> };

/** One reported event as it is stored, or null for one the run view doesn't show. */
export function normaliseEvent(e: ReportedEvent): Stored | null {
  const base = { seq: e.seq, at: e.at };
  if (e.type === "message" && e.role === "assistant" && e.text?.trim()) {
    return { ...base, kind: "note", data: { text: clip(e.text.trim(), RUN_EVENT_TEXT_MAX) } };
  }
  if (e.type === "tool" && e.name) {
    return {
      ...base,
      kind: "tool",
      data: {
        name: clip(e.name, 200),
        label: toolLabel(e.name, e.input),
        input: clip(e.input ?? "", RUN_EVENT_TEXT_MAX),
        toolId: e.id ?? null,
      },
    };
  }
  if (e.type === "tool.result" && e.toolId) {
    return {
      ...base,
      kind: "result",
      data: {
        toolId: e.toolId,
        output: clip(e.output ?? "", RUN_EVENT_TEXT_MAX),
        isError: e.isError === true,
      },
    };
  }
  return null;
}

/** A `turn`'s tokens: input, output and cache reads and writes together. */
const turnTokens = (e: ReportedEvent) =>
  e.type === "turn" && e.usage
    ? e.usage.inputTokens +
      e.usage.outputTokens +
      e.usage.cacheReadTokens +
      e.usage.cacheWriteTokens
    : 0;

/**
 * Stores a batch of the runner's events for `runId`: the ones the run view shows, in seq order,
 * up to RUN_EVENTS_CAP for the run, and the run's totals. Events at or below the run's last stored
 * seq (a replay) are skipped. One read of the run's totals (by primary key) and, when there is
 * anything to keep, one D1 batch; a batch of only logs and status changes writes nothing. Two
 * batches racing: the second is a conflict, read again and retried once. Returns how many it
 * stored. The caller has checked the runner holds the run.
 */
export async function storeRunEvents(
  d1: D1Database,
  runId: string,
  events: ReportedEvent[],
): Promise<{ stored: number; truncated: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await storeOnce(d1, runId, events);
    } catch (error) {
      if (attempt > 0 || !(error instanceof StoreError) || error.code !== "conflict") throw error;
    }
  }
}

async function storeOnce(
  d1: D1Database,
  runId: string,
  events: ReportedEvent[],
): Promise<{ stored: number; truncated: boolean }> {
  const db = flowDb(d1);
  const run = await db
    .selectFrom("flow_runs")
    .select(["org_id", "event_count", "last_event_seq", "steps", "events_truncated", "tokens"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) throw new StoreError("not_found", `No run ${runId}.`);
  const fresh = events.filter((e) => e.seq > run.last_event_seq).sort((a, b) => a.seq - b.seq);
  const kept = fresh.map(normaliseEvent).filter((e): e is Stored => e !== null);
  const tokens = fresh.reduce((sum, e) => sum + turnTokens(e), 0);
  const steps = kept.filter((e) => e.kind === "tool").length;
  if (kept.length === 0 && tokens === 0) {
    return { stored: 0, truncated: run.events_truncated === 1 };
  }
  const room = Math.max(0, RUN_EVENTS_CAP - run.event_count);
  const stored = kept.slice(0, room);
  const truncated = run.events_truncated === 1 || kept.length > room;
  const lastSeq = Math.max(run.last_event_seq, ...fresh.map((e) => e.seq));
  const statements: D1PreparedStatement[] = [];
  if (stored.length > 0) {
    // One statement for the whole batch: D1 binds at most 100 parameters, so the rows go in as
    // one JSON array.
    statements.push(
      d1
        .prepare(
          `INSERT INTO flow_run_events (run_id, seq, org_id, at, kind, data)
           SELECT ?1, json_extract(value, '$.seq'), ?2, json_extract(value, '$.at'),
             json_extract(value, '$.kind'), json_extract(value, '$.data')
           FROM json_each(?3)`,
        )
        .bind(
          runId,
          run.org_id,
          JSON.stringify(stored.map((e) => ({ ...e, data: JSON.stringify(e.data) }))),
        ),
    );
  }
  statements.push(
    toStatement(
      d1,
      db
        .updateTable("flow_runs")
        .set({
          event_count: run.event_count + stored.length,
          last_event_seq: lastSeq,
          // Every tool call reported counts, kept or dropped over the cap.
          steps: run.steps + steps,
          events_truncated: truncated ? 1 : 0,
          ...(tokens > 0 ? { tokens: (run.tokens ?? 0) + tokens } : {}),
        })
        .where("id", "=", runId)
        .where("last_event_seq", "=", run.last_event_seq),
    ),
    guardChanged(d1, "flow_runs.last_event_seq"),
  );
  try {
    await writeBatch(d1, statements);
  } catch (error) {
    // The same seq stored by a racing batch: a conflict, as a failed guard is.
    if (/UNIQUE constraint failed: flow_run_events\./.test(String(error))) {
      throw new StoreError("conflict", "Another batch stored these events first.");
    }
    throw error;
  }
  return { stored: stored.length, truncated };
}

/**
 * A run's stored events after seq `after`, in order, at most `limit` (RUN_EVENTS_PAGE). Reads the
 * primary key (run_id, seq).
 */
export async function runEvents(
  d1: D1Database,
  runId: string,
  after = 0,
  limit = RUN_EVENTS_PAGE,
): Promise<RunEvent[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_run_events")
    .select(["seq", "at", "kind", "data"])
    .where("run_id", "=", runId)
    .where("seq", ">", after)
    .orderBy("seq")
    .limit(Math.max(1, Math.min(limit, RUN_EVENTS_PAGE)))
    .execute();
  return rows.map(
    (r) => ({ seq: r.seq, at: r.at, kind: r.kind, ...JSON.parse(r.data) }) as RunEvent,
  );
}

/**
 * What the run view polls while a run is live: its events after `after`, whether some were dropped
 * over the cap, and whether the run has ended. Two point reads, null when there is no such run.
 */
export async function runEventsPage(
  d1: D1Database,
  runId: string,
  after = 0,
): Promise<{ events: RunEvent[]; truncated: boolean; done: boolean } | null> {
  const [run, events] = await Promise.all([
    flowDb(d1)
      .selectFrom("flow_runs")
      .select(["status", "events_truncated"])
      .where("id", "=", runId)
      .executeTakeFirst(),
    runEvents(d1, runId, after),
  ]);
  if (!run) return null;
  return {
    events,
    truncated: run.events_truncated === 1,
    done: run.status !== "queued" && run.status !== "claimed",
  };
}

/**
 * Deletes the events of runs that finished more than RUN_EVENTS_KEEP_DAYS ago, oldest run first:
 * each round picks the oldest due run (flow_runs_events_due_idx) and deletes up to `batch` of its
 * events by primary key, and, once it has none left, sets its event_count to 0 so it leaves the
 * index. At most `rounds` rounds (a backlog drains over several ticks). The run row is kept.
 * Returns the events deleted.
 */
export async function pruneRunEvents(
  d1: D1Database,
  now: number,
  batch = RUN_EVENTS_PRUNE_BATCH,
  rounds = RUN_EVENTS_PRUNE_ROUNDS,
): Promise<number> {
  const db = flowDb(d1);
  const cutoff = iso(now - RUN_EVENTS_KEEP_DAYS * 86_400_000);
  let deleted = 0;
  for (let round = 0; round < rounds; round++) {
    const due = await db
      .selectFrom("flow_runs")
      .select("id")
      .where("event_count", ">", 0)
      .where("finished_at", "<", cutoff)
      .orderBy("finished_at")
      .limit(1)
      .executeTakeFirst();
    if (!due) break;
    const [gone] = await d1.batch([
      d1
        .prepare(
          `DELETE FROM flow_run_events WHERE run_id = ?1 AND seq IN
             (SELECT seq FROM flow_run_events WHERE run_id = ?1 ORDER BY seq LIMIT ?2)`,
        )
        .bind(due.id, batch),
      d1
        .prepare(
          `UPDATE flow_runs SET event_count = 0 WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM flow_run_events WHERE run_id = ?1)`,
        )
        .bind(due.id),
    ]);
    deleted += gone?.meta.changes ?? 0;
  }
  return deleted;
}
