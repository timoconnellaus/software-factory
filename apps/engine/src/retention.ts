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

const DAY = 86_400_000;

/** How long each table is kept. Changing a period is a code change, reviewed like any other. */
export const RETENTION = {
  runEventsDays: 30,
  connectorEventsDays: 30,
  /** After this the intake event keeps its id (the dedupe) and title, not its body. */
  intakeBodyDays: 90,
  terminalAttachesDays: 90,
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
 * them back from there (migration 0362). Stored rows per archive chunk, and bytes per chunk: a
 * page of run.live reads one chunk.
 */
export const ARCHIVE = {
  afterDays: 30,
  chunkRows: 200,
  chunkBytes: 1_000_000,
  /**
   * The backlog's share of the day, in stored rows (each deleted row is 2 rows written): 400k rows
   * a day is 800k rows written, about half of D1's included 50M a month, so the first weeks'
   * backlog drains inside the allowance. A backlog of 17M rows drains in about 43 days.
   */
  backlogRowsPerDay: 400_000,
  /**
   * Runs coming due are archived at this multiple of the rate they come due at, so the archive
   * always gains on its backlog, whatever the rows a day.
   */
  inflowFactor: 1.5,
  /** D1 queries the archive may make in one tick (AGENTS.md "Cloudflare cost", rule 7). */
  maxQueriesPerTick: 120,
} as const;

/** Where a run's archive lives in sf-archive. */
export const runArchivePrefix = (workItemId: string, runId: string) =>
  `runs/${workItemId}/${runId}/`;

const ROWS_EMA_KEY = "archive:rows-per-run";

/**
 * This tick's budget of stored rows: the backlog's share of a minute, plus 1.5 times the rows that
 * come due in a minute (the runs that ended in the day before the cutoff, times the rows an
 * archived run has had on average). Adaptive: busier days a month ago mean a bigger budget now, so
 * the archive never falls behind for good.
 */
export async function archiveBudget(db: D1Database, now: Date): Promise<number> {
  const cutoff = now.getTime() - ARCHIVE.afterDays * DAY;
  const [due, ema] = await db.batch([
    db
      .prepare(
        `SELECT count(*) AS n FROM core_runs
         WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at >= ? AND ended_at < ?`,
      )
      .bind(new Date(cutoff - DAY).toISOString(), new Date(cutoff).toISOString()),
    db.prepare("SELECT value FROM core_meta WHERE key = ?").bind(ROWS_EMA_KEY),
  ]);
  const runsPerDay = Number((due?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const rowsPerRun = Number((ema?.results[0] as { value?: string } | undefined)?.value ?? 500);
  const perDay = ARCHIVE.backlogRowsPerDay + ARCHIVE.inflowFactor * runsPerDay * rowsPerRun;
  return Math.max(ARCHIVE.chunkRows, Math.ceil(perDay / 1440));
}

/**
 * Archives due runs' events (then steers) to R2 and deletes them from D1, oldest run first, a
 * chunk at a time, until this tick's row budget or query budget is spent. A chunk is written to R2
 * and recorded in core_run_archive_chunks in the batch that deletes its rows, so a tick that dies
 * after the put only rewrites the same object next time, and a chunk is never deleted unrecorded.
 * Returns the stored rows archived.
 */
export async function archiveRunEvents(
  env: Pick<Env, "DB" | "ARCHIVE">,
  now = new Date(),
  opts: { rows?: number; chunkRows?: number } = {},
): Promise<number> {
  const before = new Date(now.getTime() - ARCHIVE.afterDays * DAY).toISOString();
  let budget = opts.rows ?? (await archiveBudget(env.DB, now));
  const chunkRows = opts.chunkRows ?? ARCHIVE.chunkRows;
  let queries = 1;
  let archived = 0;
  while (budget > 0 && queries + 3 <= ARCHIVE.maxQueriesPerTick) {
    const run = await env.DB.prepare(
      `SELECT id, work_item_id FROM core_runs
       WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at < ?
       ORDER BY ended_at LIMIT 1`,
    )
      .bind(before)
      .first<{ id: string; work_item_id: string }>();
    queries++;
    if (!run) break;
    const prefix = runArchivePrefix(run.work_item_id, run.id);
    const { results } = await env.DB.prepare(
      `SELECT seq, last_seq, at, type, payload FROM core_run_events
       WHERE run_id = ? ORDER BY seq LIMIT ?`,
    )
      .bind(run.id, Math.min(chunkRows, budget))
      .all<{ seq: number; last_seq: number | null; at: string; type: string; payload: string }>();
    queries++;
    if (results.length > 0) {
      // Cut the chunk at ~1 MB: a page of run.live reads one chunk.
      let bytes = 0;
      let take = 0;
      for (const r of results) {
        bytes += r.payload.length + 80;
        take++;
        if (bytes >= ARCHIVE.chunkBytes) break;
      }
      const chunk = results.slice(0, take);
      const first = chunk[0]?.seq ?? 0;
      const last = chunk.at(-1);
      const lastSeq = last?.last_seq ?? last?.seq ?? first;
      const key = `${prefix}events-${String(first).padStart(10, "0")}.ndjson`;
      const put = await putNdjson(env.ARCHIVE, key, chunk);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO core_run_archive_chunks (run_id, first_seq, last_seq, r2_key, rows, bytes, sha256, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, first_seq) DO UPDATE SET
             last_seq = excluded.last_seq, rows = excluded.rows, bytes = excluded.bytes,
             sha256 = excluded.sha256, archived_at = excluded.archived_at`,
        ).bind(run.id, first, lastSeq, key, chunk.length, put.bytes, put.sha256, now.toISOString()),
        env.DB.prepare(
          "DELETE FROM core_run_events WHERE run_id = ? AND seq >= ? AND seq <= ?",
        ).bind(run.id, first, last?.seq ?? first),
      ]);
      queries++;
      budget -= chunk.length;
      archived += chunk.length;
      continue;
    }
    // Events done: the steers, one object for the run, then the mark.
    const { results: steers } = await env.DB.prepare(
      `SELECT id, author_user_id, text, kind, interrupt, created_at, delivered_at
       FROM core_run_steers WHERE run_id = ? ORDER BY created_at, id`,
    )
      .bind(run.id)
      .all<{ id: string }>();
    queries++;
    const marks: D1PreparedStatement[] = [];
    if (steers.length > 0) {
      const key = `${prefix}steers.ndjson`;
      const put = await putNdjson(env.ARCHIVE, key, steers);
      marks.push(
        env.DB.prepare(
          `INSERT INTO core_run_archive_chunks (run_id, first_seq, last_seq, r2_key, rows, bytes, sha256, archived_at)
           VALUES (?, -1, -1, ?, ?, ?, ?, ?) ON CONFLICT (run_id, first_seq) DO UPDATE SET
             rows = excluded.rows, bytes = excluded.bytes, sha256 = excluded.sha256`,
        ).bind(run.id, key, steers.length, put.bytes, put.sha256, now.toISOString()),
        env.DB.prepare("DELETE FROM core_run_steers WHERE run_id = ?").bind(run.id),
      );
    }
    const total = await env.DB.prepare(
      "SELECT coalesce(sum(rows), 0) AS n FROM core_run_archive_chunks WHERE run_id = ? AND first_seq >= 0",
    )
      .bind(run.id)
      .first<number>("n");
    queries++;
    marks.push(
      env.DB.prepare("UPDATE core_runs SET events_archived_at = ? WHERE id = ?").bind(
        now.toISOString(),
        run.id,
      ),
      // The average stored rows per run, for the next ticks' budget (a moving average).
      env.DB.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = CAST(0.9 * CAST(value AS REAL) + 0.1 * ? AS TEXT)`,
      ).bind(ROWS_EMA_KEY, String(total ?? 0), total ?? 0),
    );
    await env.DB.batch(marks);
    queries++;
    archived += steers.length;
    budget -= Math.max(1, steers.length);
  }
  return archived;
}

async function putNdjson(
  bucket: R2Bucket,
  key: string,
  rows: unknown[],
): Promise<{ bytes: number; sha256: string }> {
  const body = new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const sha256 = Array.from(sha, (b) => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(rows.length), sha256 },
    sha256,
  });
  return { bytes: body.length, sha256 };
}
