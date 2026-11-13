// Retention of the tables that only grew (AGENTS.md "Cloudflare cost", rule 3). Each prune is
// bounded per tick and reads through an index on its time column (migration 0361), so a tick with
// nothing due reads nothing. What only served a short-lived check is deleted; what a person may want
// to read later is kept, or (a run's events and steers) archived with a way to read it back.
//
//   table                        kept                             then
//   core_connector_events        30 days (webhook redelivery)     deleted
//   core_intake_events           forever, the event-id dedupe     body cleared after 90 days
//   core_run_terminal_attaches   90 days                          deleted (the audit keeps each attach)
//   device codes, connect states a day past their expiry          deleted
//   core_planning_events         kept: the planning record (ADR 0350), one row per person's action
//   core_run_events, _steers     30 days after the run ended      archived to sf-archive, read back
//                                                                  by run.live, then deleted

import { invoke, RUN_ARCHIVE_AFTER_DAYS, SCHEDULER } from "@software-factory/core";
import { invokeDeps } from "./deps.ts";

const DAY = 86_400_000;

/** How long each table is kept. Changing a period is a code change, reviewed like any other. */
export const RETENTION = {
  runEventsDays: 30,
  connectorEventsDays: 30,
  /** After this the intake event keeps its id (the dedupe) and title, not its body. */
  intakeBodyDays: 90,
  terminalAttachesDays: 90,
  /** An autopilot's run history (migration 0284); a run's work item keeps its own. */
  autopilotRunsDays: 90,
  expiredGraceDays: 1,
} as const;

/** Rows each prune handles per round: one D1 batch (one query) covers every table. */
export const PRUNE_BATCH = 500;
/** Rounds per tick at most, while some table still fills its batch: 5,000 rows a table an hour. */
export const PRUNE_ROUNDS = 10;

/** The expiring tables and their time columns: each has an index on that column (0361, 0040). */
const PRUNES: { table: string; column: string; days: number }[] = [
  {
    table: "core_connector_events",
    column: "received_at",
    days: RETENTION.connectorEventsDays,
  },
  {
    table: "core_run_terminal_attaches",
    column: "opened_at",
    days: RETENTION.terminalAttachesDays,
  },
  { table: "core_runner_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_cli_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_github_connect_states", column: "expires_at", days: RETENTION.expiredGraceDays },
  // core_autopilot_runs_created_idx (created_at): the prune's own index.
  { table: "core_autopilot_runs", column: "created_at", days: RETENTION.autopilotRunsDays },
];

/**
 * Deletes due rows from each expiring table and clears old intake bodies, `batch` rows a table a
 * round, each round one D1 batch, again while any table filled its batch, at most `rounds` times
 * (a backlog drains over several ticks). Returns the rows handled per table.
 */
export async function pruneExpired(
  db: D1Database,
  now = new Date(),
  batch = PRUNE_BATCH,
  rounds = PRUNE_ROUNDS,
): Promise<Record<string, number>> {
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const work = [
    ...PRUNES.map(({ table, column, days }) => ({
      name: table,
      stmt: db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`,
        )
        .bind(cutoff(days), batch),
    })),
    {
      name: "core_intake_events",
      stmt: db
        .prepare(
          `UPDATE core_intake_events SET body = '' WHERE rowid IN (
             SELECT rowid FROM core_intake_events WHERE body != '' AND received_at < ? LIMIT ?)`,
        )
        .bind(cutoff(RETENTION.intakeBodyDays), batch),
    },
  ];
  const handled: Record<string, number> = Object.fromEntries(work.map((w) => [w.name, 0]));
  let pending = work;
  for (let round = 0; round < rounds && pending.length > 0; round++) {
    const results = await db.batch(pending.map((w) => w.stmt));
    const full: typeof work = [];
    pending.forEach((w, i) => {
      const n = results[i]?.meta.changes ?? 0;
      handled[w.name] = (handled[w.name] ?? 0) + n;
      if (n >= batch) full.push(w);
    });
    pending = full;
  }
  return handled;
}

/**
 * A run's events and steers move to R2 (sf-archive) this long after it ended, and run.live reads
 * them back from there (migration 0362). A page of run.live reads one chunk.
 */
export const ARCHIVE = {
  afterDays: RUN_ARCHIVE_AFTER_DAYS,
  /** Stored rows per chunk at most. */
  chunkRows: 200,
  /** Bytes per chunk at most: the chunk is cut before a row would take it past this. */
  chunkBytes: 1_000_000,
  /** The archiver's lease on a run; every chunk renews it. A tick runs well under a minute. */
  leaseMs: 5 * 60_000,
  /**
   * Runs coming due are archived at this multiple of the rate they come due at, so the archive
   * always gains on them, whatever the rows a day.
   */
  inflowFactor: 1.5,
  /** D1 rows written for each stored row archived: the row and its primary-key entry. */
  writesPerRow: 2,
  /**
   * The backlog drain's own budget of D1 rows written in a calendar month (UTC), spread over the
   * days left in it. The drain counts its writes against it (core_meta `archive:state`).
   */
  drainWritesPerMonth: 15_000_000,
  /**
   * The drain gives way so that live traffic, the inflow and the drain together stay under this
   * many rows written a month: 80% of D1's included 50M, leaving room for everything else.
   */
  monthlyWriteCeiling: 40_000_000,
  /** Rows a continuously logging job writes a day (about 7.8M a month). */
  busyJobWritesPerDay: 260_000,
  /** A running job that reported an event this recently counts as busy. */
  busyWithinMs: 10 * 60_000,
  /** D1 queries the archive may make in one tick (AGENTS.md "Cloudflare cost", rule 7). */
  maxQueriesPerTick: 120,
} as const;

/** Where a run's archive lives in sf-archive. */
export const runArchivePrefix = (workItemId: string, runId: string) =>
  `runs/${workItemId}/${runId}/`;

/** The object holding a run's events from `first` to `last` (seqs): named by its range. */
export const eventsChunkKey = (prefix: string, first: number, last: number) =>
  `${prefix}events-${String(first).padStart(10, "0")}-${String(last).padStart(10, "0")}.ndjson`;

const ROWS_EMA_KEY = "archive:rows-per-run";
const STATE_KEY = "archive:state";
const STATUS_KEY = "archive:status";
const ACTIVE_RUNS = ["claimed", "preparing", "running", "collecting"];

/** The drain's month so far and the rows it may still archive, carried between ticks. */
type ArchiveState = { month: string; drainWrites: number; credit: number };

export type ArchiveBudget = {
  /** Stored rows this tick may archive (whole, from the credit carried between ticks). */
  rows: number;
  /** Of which the backlog drain's share, the rest keeping up with runs coming due. */
  drainShare: number;
  /** Stored rows a day each part archives at the current rates. */
  drainRowsPerDay: number;
  inflowRowsPerDay: number;
  /** Jobs logging now, and the rows a day they are taken to write. */
  busyJobs: number;
  liveWritesPerDay: number;
  state: ArchiveState;
};

const month = (now: Date) => now.toISOString().slice(0, 7);

/**
 * This tick's budget of stored rows (AGENTS.md "Cloudflare cost"): 1.5 times the rows coming due
 * (the runs that ended in the day before the cutoff, times the rows an archived run has had on
 * average), so the archive keeps up, plus the backlog drain's share. The drain spends at most its
 * monthly budget (15M rows written) spread over the days left in the month, and gives way to live
 * traffic: each job logging now is taken to write 260k rows a day, and the drain takes only what
 * keeps live, inflow and drain under 40M rows written a month. Four busy jobs leave it nothing.
 * Whatever a tick doesn't spend is credit for the next, so a chunk is never cut small.
 */
export async function archiveBudget(db: D1Database, now: Date): Promise<ArchiveBudget> {
  const cutoff = now.getTime() - ARCHIVE.afterDays * DAY;
  const [due, ema, state, active] = await db.batch([
    db
      .prepare(
        `SELECT count(*) AS n FROM core_runs
         WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at >= ? AND ended_at < ?`,
      )
      .bind(new Date(cutoff - DAY).toISOString(), new Date(cutoff).toISOString()),
    db.prepare("SELECT value FROM core_meta WHERE key = ?").bind(ROWS_EMA_KEY),
    db.prepare("SELECT value FROM core_meta WHERE key = ?").bind(STATE_KEY),
    // The active runs only (core_runs_status_idx): a runner holds a few at a time.
    db
      .prepare(
        `SELECT last_event_at FROM core_runs WHERE status IN (${ACTIVE_RUNS.map(() => "?").join(", ")}) LIMIT 500`,
      )
      .bind(...ACTIVE_RUNS),
  ]);
  const runsPerDay = Number((due?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const rowsPerRun = Number((ema?.results[0] as { value?: string } | undefined)?.value ?? 500);
  let carried: ArchiveState = { month: month(now), drainWrites: 0, credit: 0 };
  try {
    const raw = (state?.results[0] as { value?: string } | undefined)?.value;
    if (raw) carried = { ...carried, ...(JSON.parse(raw) as Partial<ArchiveState>) };
  } catch {
    // A state we can't read starts the month's count again: the ceiling below still holds.
  }
  if (carried.month !== month(now)) carried = { ...carried, month: month(now), drainWrites: 0 };
  const busyJobs = ((active?.results ?? []) as { last_event_at: string | null }[]).filter(
    (r) => r.last_event_at && now.getTime() - Date.parse(r.last_event_at) < ARCHIVE.busyWithinMs,
  ).length;
  const liveWritesPerDay = busyJobs * ARCHIVE.busyJobWritesPerDay;
  const inflowRowsPerDay = ARCHIVE.inflowFactor * runsPerDay * rowsPerRun;
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(1, (monthEnd - now.getTime()) / DAY);
  const paced = Math.max(0, ARCHIVE.drainWritesPerMonth - carried.drainWrites) / daysLeft;
  const headroom = Math.max(
    0,
    ARCHIVE.monthlyWriteCeiling / 30 - liveWritesPerDay - inflowRowsPerDay * ARCHIVE.writesPerRow,
  );
  const drainRowsPerDay = Math.min(paced, headroom) / ARCHIVE.writesPerRow;
  const perTick = (drainRowsPerDay + inflowRowsPerDay) / 1440;
  // A tick never banks more than a few chunks' worth (a long quiet spell isn't a burst later).
  const credit = Math.min(carried.credit + perTick, ARCHIVE.chunkRows * 20);
  const rows = Math.floor(credit);
  return {
    rows,
    drainShare: perTick > 0 ? drainRowsPerDay / 1440 / perTick : 0,
    drainRowsPerDay,
    inflowRowsPerDay,
    busyJobs,
    liveWritesPerDay,
    state: { ...carried, credit },
  };
}

/** Why a chunk wasn't archived: the lease went to another tick, or D1 and the object disagree. */
class ArchiveStop extends Error {}

/**
 * Archives due runs' events (then steers) to R2 and deletes them from D1, oldest run first, a
 * chunk at a time, until this tick's row budget or query budget is spent. Returns the stored rows
 * archived.
 *
 * A row is deleted only once an object that provably holds it exists:
 * - one tick archives a run at a time: it takes the run's lease (core_run_archive_leases) and an
 *   overlapping tick that can't skips the run rather than racing;
 * - each object is named by the seq range it holds and written create-only, so two chunkings can
 *   never overwrite each other; when the key is already there (a tick that died after its put),
 *   the object is read back, checked against its checksum and its range, and used as it is;
 * - a fresh put is verified (R2 checks the SHA-256 we computed, and we compare the one it returns)
 *   before anything is deleted;
 * - the chunk's record and the delete of its rows are one D1 batch: the record is written only
 *   while this tick holds the lease and every row the object holds is still there, and the delete
 *   only where a record names that object.
 */
export async function archiveRunEvents(
  env: Pick<Env, "DB" | "ARCHIVE">,
  now = new Date(),
  opts: { rows?: number; chunkRows?: number } = {},
): Promise<number> {
  const before = new Date(now.getTime() - ARCHIVE.afterDays * DAY).toISOString();
  const nowIso = now.toISOString();
  const leaseUntil = () => new Date(Date.now() + ARCHIVE.leaseMs).toISOString();
  const budgeted = opts.rows === undefined ? await archiveBudget(env.DB, now) : null;
  let budget = opts.rows ?? budgeted?.rows ?? 0;
  const chunkRows = opts.chunkRows ?? ARCHIVE.chunkRows;
  const holder = crypto.randomUUID();
  let queries = budgeted ? 2 : 0;
  let archived = 0;
  let current: { id: string; work_item_id: string } | null = null;
  try {
    while (budget > 0 && queries + 4 <= ARCHIVE.maxQueriesPerTick) {
      if (!current) {
        const run = await env.DB.prepare(
          `SELECT id, work_item_id FROM core_runs
           WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at < ?
           ORDER BY ended_at LIMIT 1`,
        )
          .bind(before)
          .first<{ id: string; work_item_id: string }>();
        queries++;
        if (!run) break;
        // The run's lease: taken when free or expired. Another tick holds it: skip, don't race.
        const lease = await env.DB.prepare(
          `INSERT INTO core_run_archive_leases (run_id, holder, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE core_run_archive_leases.expires_at <= ?`,
        )
          .bind(run.id, holder, leaseUntil(), new Date().toISOString())
          .run();
        queries++;
        if ((lease.meta.changes ?? 0) === 0) break;
        current = run;
      }
      const run = current;
      const prefix = runArchivePrefix(run.work_item_id, run.id);
      const { results } = await env.DB.prepare(
        `SELECT seq, last_seq, at, type, payload FROM core_run_events
         WHERE run_id = ? ORDER BY seq LIMIT ?`,
      )
        .bind(run.id, Math.min(chunkRows, budget))
        .all<StoredRow>();
      queries++;
      if (results.length > 0) {
        const chunk = cutChunk(results);
        const n = await archiveChunk(env, run.id, prefix, chunk, holder, leaseUntil());
        queries++;
        budget -= n;
        archived += n;
        continue;
      }
      // Events done: the steers, one object for the run, then the mark.
      archived += await finishRun(env, run.id, prefix, holder, nowIso);
      queries += 3;
      budget -= 1;
      current = null;
    }
  } catch (error) {
    if (!(error instanceof ArchiveStop)) throw error;
    console.warn(`archive stopped: ${error.message}`);
  } finally {
    // Hand back a run left part-way, so the next tick takes it at once.
    if (current) {
      await env.DB.prepare("DELETE FROM core_run_archive_leases WHERE run_id = ? AND holder = ?")
        .bind(current.id, holder)
        .run();
    }
    if (budgeted) {
      const spent = Math.min(budgeted.rows, archived);
      const state: ArchiveState = {
        ...budgeted.state,
        credit: Math.max(0, budgeted.state.credit - spent),
        drainWrites: Math.round(
          budgeted.state.drainWrites + spent * budgeted.drainShare * ARCHIVE.writesPerRow,
        ),
      };
      await env.DB.prepare(
        "INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
        .bind(STATE_KEY, JSON.stringify(state))
        .run();
    }
  }
  return archived;
}

type StoredRow = {
  seq: number;
  last_seq: number | null;
  at: string;
  type: string;
  payload: string;
};

/** The rows of one chunk: at most `chunkBytes`, cut before the row that would pass it (one at least). */
export function cutChunk<T extends { payload: string }>(rows: T[]): T[] {
  let bytes = 0;
  let take = 0;
  for (const r of rows) {
    const size = r.payload.length + 80;
    if (take > 0 && bytes + size > ARCHIVE.chunkBytes) break;
    bytes += size;
    take++;
  }
  return rows.slice(0, take);
}

/**
 * Puts one chunk and, in one D1 batch, records it and deletes its rows (see archiveRunEvents).
 * Returns the stored rows archived; throws ArchiveStop when the lease was lost or D1 and the
 * object disagree, so the tick stops instead of deleting anything.
 */
async function archiveChunk(
  env: Pick<Env, "DB" | "ARCHIVE">,
  runId: string,
  prefix: string,
  chunk: StoredRow[],
  holder: string,
  leaseUntil: string,
): Promise<number> {
  const first = chunk[0]?.seq ?? 0;
  const lastRow = chunk.at(-1);
  const last = lastRow?.last_seq ?? lastRow?.seq ?? first;
  const key = eventsChunkKey(prefix, first, last);
  const stored = await putOnce(env.ARCHIVE, key, chunk, (rows) => {
    const r = rows as StoredRow[];
    const end = r.at(-1);
    return r[0]?.seq === first && (end?.last_seq ?? end?.seq) === last;
  });
  const nowIso = new Date().toISOString();
  const started = chunk.findLast((r) => r.type === "session.started");
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_run_archive_chunks (run_id, first_seq, last_seq, r2_key, rows, bytes, sha256, archived_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM core_run_archive_leases WHERE run_id = ? AND holder = ? AND expires_at > ?)
         AND (SELECT count(*) FROM core_run_events WHERE run_id = ? AND seq BETWEEN ? AND ?) = ?`,
    ).bind(
      runId,
      first,
      last,
      key,
      stored.rows,
      stored.bytes,
      stored.sha256,
      nowIso,
      runId,
      holder,
      nowIso,
      runId,
      first,
      last,
      stored.rows,
    ),
    env.DB.prepare(
      `DELETE FROM core_run_events WHERE run_id = ? AND seq BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM core_run_archive_chunks WHERE run_id = ? AND first_seq = ? AND last_seq = ? AND r2_key = ?)`,
    ).bind(runId, first, last, runId, first, last, key),
    env.DB.prepare(
      "UPDATE core_run_archive_leases SET expires_at = ? WHERE run_id = ? AND holder = ?",
    ).bind(leaseUntil, runId, holder),
    // How the session ran outlives its `session.started` event (ADR 0450, run.live's chat view).
    ...(started
      ? [
          env.DB.prepare(
            "UPDATE core_runs SET session_mode = ? WHERE id = ? AND session_mode IS NULL",
          ).bind(sessionModeOf(started.payload), runId),
        ]
      : []),
  ]);
  const deleted = results[1]?.meta.changes ?? 0;
  if ((results[2]?.meta.changes ?? 0) === 0) {
    throw new ArchiveStop(`lost the lease on ${runId}`);
  }
  if (deleted !== stored.rows) {
    throw new ArchiveStop(
      `${key}: ${stored.rows} rows in the object, ${deleted} deleted from D1; left for a person`,
    );
  }
  return deleted;
}

function sessionModeOf(payload: string): "stream" | "terminal" {
  try {
    return (JSON.parse(payload) as { mode?: unknown }).mode === "stream" ? "stream" : "terminal";
  } catch {
    return "terminal";
  }
}

/** The run's steers (one object), then the mark, in one batch; drops the lease. */
async function finishRun(
  env: Pick<Env, "DB" | "ARCHIVE">,
  runId: string,
  prefix: string,
  holder: string,
  nowIso: string,
): Promise<number> {
  const { results: steers } = await env.DB.prepare(
    `SELECT id, author_user_id, text, kind, interrupt, created_at, delivered_at, undeliverable_at
     FROM core_run_steers WHERE run_id = ? ORDER BY created_at, id LIMIT 1000`,
  )
    .bind(runId)
    .all<{ id: string }>();
  const held = `EXISTS (SELECT 1 FROM core_run_archive_leases WHERE run_id = ? AND holder = ? AND expires_at > ?)`;
  // The lease is timed by the clock, whatever day the tick archives as.
  const clock = new Date().toISOString();
  const marks: D1PreparedStatement[] = [];
  if (steers.length > 0) {
    const key = `${prefix}steers.ndjson`;
    const ids = new Set(steers.map((s) => s.id));
    const stored = await putOnce(env.ARCHIVE, key, steers, (rows) =>
      (rows as { id: string }[]).every((r) => ids.has(r.id)),
    );
    marks.push(
      env.DB.prepare(
        `INSERT INTO core_run_archive_chunks (run_id, first_seq, last_seq, r2_key, rows, bytes, sha256, archived_at)
         SELECT ?, -1, -1, ?, ?, ?, ?, ?
         WHERE ${held} AND NOT EXISTS (SELECT 1 FROM core_run_archive_chunks WHERE run_id = ? AND first_seq = -1)`,
      ).bind(
        runId,
        key,
        stored.rows,
        stored.bytes,
        stored.sha256,
        nowIso,
        runId,
        holder,
        clock,
        runId,
      ),
      // Only the steers the object holds, and only where a record names it.
      env.DB.prepare(
        `DELETE FROM core_run_steers WHERE run_id = ? AND id IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM core_run_archive_chunks WHERE run_id = ? AND first_seq = -1 AND r2_key = ?)`,
      ).bind(runId, JSON.stringify(stored.ids ?? []), runId, key),
    );
  }
  const total = await env.DB.prepare(
    "SELECT coalesce(sum(rows), 0) AS n FROM core_run_archive_chunks WHERE run_id = ? AND first_seq >= 0",
  )
    .bind(runId)
    .first<number>("n");
  marks.push(
    // Marked only with nothing of the run left in D1, while this tick holds the lease.
    env.DB.prepare(
      `UPDATE core_runs SET events_archived_at = ? WHERE id = ? AND events_archived_at IS NULL
       AND ${held}
       AND NOT EXISTS (SELECT 1 FROM core_run_events WHERE run_id = ?)
       AND NOT EXISTS (SELECT 1 FROM core_run_steers WHERE run_id = ?)`,
    ).bind(nowIso, runId, runId, holder, clock, runId, runId),
    // The average stored rows per run, for the next ticks' budget (a moving average).
    env.DB.prepare(
      `INSERT INTO core_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = CAST(0.9 * CAST(value AS REAL) + 0.1 * ? AS TEXT)`,
    ).bind(ROWS_EMA_KEY, String(total ?? 0), total ?? 0),
    env.DB.prepare("DELETE FROM core_run_archive_leases WHERE run_id = ? AND holder = ?").bind(
      runId,
      holder,
    ),
  );
  const results = await env.DB.batch(marks);
  const marked = results[marks.length - 3]?.meta.changes ?? 0;
  if (marked === 0)
    throw new ArchiveStop(`${runId}: not marked archived (lease lost or rows left)`);
  return steers.length;
}

/**
 * Writes `rows` as NDJSON at `key`, create-only, and returns what the object at `key` provably
 * holds. A fresh put is checked by R2 against the SHA-256 we computed, and the one it returns is
 * compared too. When the key is already there (a tick that died after its put), the object is read
 * back, its body checked against its recorded checksum and by `fits` (its range), and used as is.
 */
async function putOnce(
  bucket: R2Bucket,
  key: string,
  rows: unknown[],
  fits: (rows: unknown[]) => boolean,
): Promise<{ rows: number; bytes: number; sha256: string; ids?: string[] }> {
  const body = new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const sha256 = await sha256Hex(body);
  const ids = idsOf(rows);
  const put = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(rows.length), sha256 },
    sha256,
  });
  if (put) {
    const returned = put.checksums.sha256 ? hex(new Uint8Array(put.checksums.sha256)) : null;
    if (returned !== null && returned !== sha256) {
      throw new ArchiveStop(`${key}: R2 holds ${returned}, we wrote ${sha256}`);
    }
    if (returned === null) {
      const head = await bucket.head(key);
      if (head?.customMetadata?.sha256 !== sha256 || head.size !== body.length) {
        throw new ArchiveStop(`${key}: the object written doesn't match`);
      }
    }
    return { rows: rows.length, bytes: body.length, sha256, ...(ids ? { ids } : {}) };
  }
  // Already there: read it back and use what it holds.
  const existing = await bucket.get(key);
  if (!existing) throw new ArchiveStop(`${key}: refused as existing, then not found`);
  const bytes = new Uint8Array(await existing.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== existing.customMetadata?.sha256) {
    throw new ArchiveStop(`${key}: its body doesn't match its checksum`);
  }
  const held = new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
  if (held.length === 0 || !fits(held)) {
    throw new ArchiveStop(`${key}: the existing object doesn't hold its range`);
  }
  const heldIds = idsOf(held);
  return {
    rows: held.length,
    bytes: bytes.length,
    sha256: actual,
    ...(heldIds ? { ids: heldIds } : {}),
  };
}

function idsOf(rows: unknown[]): string[] | undefined {
  const ids = rows.map((r) => (r as { id?: unknown }).id);
  return ids.every((id) => typeof id === "string") ? (ids as string[]) : undefined;
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Once a day: how long the backlog will take to drain at the current rates, kept in core_meta
 * (`archive:status`) and logged. The backlog is the due runs (the partial index of runs still to
 * archive, read at most 100k entries, once a day) times the rows an archived run has had.
 */
export async function archiveStatus(db: D1Database, now: Date): Promise<ArchiveStatus> {
  const before = new Date(now.getTime() - ARCHIVE.afterDays * DAY).toISOString();
  const budget = await archiveBudget(db, now);
  const [runs, ema] = await db.batch([
    db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM core_runs
         WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at < ? LIMIT 100000)`,
      )
      .bind(before),
    db.prepare("SELECT value FROM core_meta WHERE key = ?").bind(ROWS_EMA_KEY),
  ]);
  const dueRuns = Number((runs?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const rowsPerRun = Number((ema?.results[0] as { value?: string } | undefined)?.value ?? 500);
  const backlogRows = Math.round(dueRuns * rowsPerRun);
  const status: ArchiveStatus = {
    at: now.toISOString(),
    dueRuns,
    backlogRows,
    drainRowsPerDay: Math.round(budget.drainRowsPerDay),
    inflowRowsPerDay: Math.round(budget.inflowRowsPerDay),
    busyJobs: budget.busyJobs,
    drainWritesThisMonth: budget.state.drainWrites,
    expectedDrainDays:
      backlogRows === 0
        ? 0
        : budget.drainRowsPerDay > 0
          ? Math.ceil(backlogRows / budget.drainRowsPerDay)
          : null,
  };
  await db
    .prepare(
      "INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(STATUS_KEY, JSON.stringify(status))
    .run();
  console.log(`archive status ${JSON.stringify(status)}`);
  return status;
}

export type ArchiveStatus = {
  at: string;
  dueRuns: number;
  backlogRows: number;
  drainRowsPerDay: number;
  inflowRowsPerDay: number;
  busyJobs: number;
  drainWritesThisMonth: number;
  /** Days to drain the backlog at today's rate; null while live traffic leaves the drain nothing. */
  expectedDrainDays: number | null;
};

/** Archived objects the daily sample checks with a HEAD. */
export const ARCHIVE_SAMPLE = 5;

/**
 * Once a day: checks a few archived objects, picked at random, with a HEAD (no read), so a lost
 * one is found without waiting for someone to open its run. Each one that is gone is reported
 * through run.reportArchiveMissing as the scheduler, which checks again for itself and opens the
 * run's one incident. Two queries (the table's top rowid, then the picks in one query with
 * json_each, each on the rowid) and a HEAD each. Returns the keys found missing.
 */
export async function sampleArchive(
  env: Env,
  now = new Date(),
  n = ARCHIVE_SAMPLE,
  pick: () => number = Math.random,
): Promise<string[]> {
  const top = await env.DB.prepare("SELECT max(rowid) AS top FROM core_run_archive_chunks").first<
    number | null
  >("top");
  if (!top) return [];
  const rowids = Array.from({ length: n }, () => 1 + Math.floor(pick() * top));
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT c.run_id, c.first_seq, c.r2_key, r.work_item_id
     FROM json_each(?) j
     JOIN core_run_archive_chunks c ON c.rowid = (
       SELECT rowid FROM core_run_archive_chunks WHERE rowid >= j.value ORDER BY rowid LIMIT 1)
     JOIN core_runs r ON r.id = c.run_id`,
  )
    .bind(JSON.stringify(rowids))
    .all<{ run_id: string; first_seq: number; r2_key: string; work_item_id: string }>();
  const missing: string[] = [];
  for (const c of results) {
    if ((await env.ARCHIVE.head(c.r2_key)) !== null) continue;
    missing.push(c.r2_key);
    try {
      await invoke(
        invokeDeps(env),
        "run.reportArchiveMissing",
        { workItemId: c.work_item_id, runId: c.run_id, firstSeq: c.first_seq },
        { actor: SCHEDULER, origin: { surface: "cron" } },
      );
    } catch (error) {
      console.error(`archive sample: couldn't report ${c.r2_key}: ${String(error)}`);
    }
  }
  if (missing.length > 0) {
    console.error(`archive sample ${now.toISOString()}: missing ${missing.join(", ")}`);
  }
  return missing;
}
