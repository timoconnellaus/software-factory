// Retention of the tables that only grew (AGENTS.md "Cloudflare cost", rule 4). Each prune is
// bounded per tick and reads through an index on its time column (migration 0361), so a tick with
// nothing due reads nothing. What a person may want to read later, a run's events and steers, is
// archived to R2 first; what only served a short-lived check is deleted.
//
//   table                        kept                             then
//   core_run_events, _steers     30 days after the run ended      archived to sf-archive, deleted
//   core_connector_events        30 days (webhook redelivery)     deleted
//   core_intake_events           90 days (an event's retries)     deleted (the work item keeps its text)
//   core_run_terminal_attaches   90 days                          deleted (the audit keeps each attach)
//   device codes, connect states a day past their expiry          deleted
//   core_planning_events         kept: the planning record (ADR 0350), one row per person's action

const DAY = 86_400_000;

/** How long each table is kept. Changing a period is a code change, reviewed like any other. */
export const RETENTION = {
  runEventsDays: 30,
  connectorEventsDays: 30,
  intakeEventsDays: 90,
  terminalAttachesDays: 90,
  expiredGraceDays: 1,
} as const;

/** Rows each prune deletes per tick, at most: 500 × 6 tables is one D1 batch (one query). */
export const PRUNE_BATCH = 500;

/** The expiring tables and their time columns: each has an index on that column (0361, 0040). */
const PRUNES: { table: string; column: string; days: number }[] = [
  {
    table: "core_connector_events",
    column: "received_at",
    days: RETENTION.connectorEventsDays,
  },
  { table: "core_intake_events", column: "received_at", days: RETENTION.intakeEventsDays },
  {
    table: "core_run_terminal_attaches",
    column: "opened_at",
    days: RETENTION.terminalAttachesDays,
  },
  { table: "core_runner_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_cli_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_github_connect_states", column: "expires_at", days: RETENTION.expiredGraceDays },
];

/** Deletes up to `batch` due rows from each expiring table, in one D1 batch. Returns rows deleted per table. */
export async function pruneExpired(
  db: D1Database,
  now = new Date(),
  batch = PRUNE_BATCH,
): Promise<Record<string, number>> {
  const results = await db.batch(
    PRUNES.map(({ table, column, days }) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`,
        )
        .bind(new Date(now.getTime() - days * DAY).toISOString(), batch),
    ),
  );
  return Object.fromEntries(PRUNES.map((p, i) => [p.table, results[i]?.meta.changes ?? 0]));
}

/** Events per archive object, and objects per tick: 3 × 2,000 events a minute, ~8.6M a day. */
export const ARCHIVE_CHUNK = 2_000;
export const ARCHIVE_CHUNKS_PER_TICK = 3;

/** Where a run's archive lives in sf-archive. */
export const runArchivePrefix = (workItemId: string, runId: string) =>
  `runs/${workItemId}/${runId}/`;

/**
 * Archives the oldest due run's events (and then its steers) to R2 and deletes them from D1, a
 * chunk at a time, oldest events first. Idempotent: a chunk is written before its rows go, under a
 * key from its first `seq`, so a tick that dies between the two rewrites the same object next time.
 * A run is marked archived once nothing of it is left. Returns the rows archived.
 */
export async function archiveRunEvents(
  env: Pick<Env, "DB" | "ARCHIVE">,
  now = new Date(),
  opts: { chunk?: number; chunks?: number } = {},
): Promise<number> {
  const chunk = opts.chunk ?? ARCHIVE_CHUNK;
  let budget = opts.chunks ?? ARCHIVE_CHUNKS_PER_TICK;
  const before = new Date(now.getTime() - RETENTION.runEventsDays * DAY).toISOString();
  const run = await env.DB.prepare(
    `SELECT id, work_item_id FROM core_runs
     WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at < ?
     ORDER BY ended_at LIMIT 1`,
  )
    .bind(before)
    .first<{ id: string; work_item_id: string }>();
  if (!run) return 0;
  const prefix = runArchivePrefix(run.work_item_id, run.id);
  let archived = 0;
  while (budget-- > 0) {
    const { results: events } = await env.DB.prepare(
      "SELECT seq, at, type, payload FROM core_run_events WHERE run_id = ? ORDER BY seq LIMIT ?",
    )
      .bind(run.id, chunk)
      .all<{ seq: number; at: string; type: string; payload: string }>();
    if (events.length > 0) {
      const first = events[0]?.seq ?? 0;
      const last = events.at(-1)?.seq ?? first;
      await putNdjson(
        env.ARCHIVE,
        `${prefix}events-${String(first).padStart(10, "0")}.ndjson`,
        events,
      );
      await env.DB.prepare("DELETE FROM core_run_events WHERE run_id = ? AND seq <= ?")
        .bind(run.id, last)
        .run();
      archived += events.length;
      continue;
    }
    const { results: steers } = await env.DB.prepare(
      `SELECT id, author_user_id, text, kind, interrupt, created_at, delivered_at
       FROM core_run_steers WHERE run_id = ? ORDER BY created_at, id LIMIT ?`,
    )
      .bind(run.id, chunk)
      .all<{ id: string; created_at: string }>();
    if (steers.length > 0) {
      await putNdjson(
        env.ARCHIVE,
        `${prefix}steers-${steers[0]?.created_at.replace(/[^0-9]/g, "")}-${steers[0]?.id}.ndjson`,
        steers,
      );
      await env.DB.prepare(
        "DELETE FROM core_run_steers WHERE run_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
        .bind(run.id, JSON.stringify(steers.map((s) => s.id)))
        .run();
      archived += steers.length;
      continue;
    }
    await env.DB.prepare("UPDATE core_runs SET events_archived_at = ? WHERE id = ?")
      .bind(now.toISOString(), run.id)
      .run();
    break;
  }
  return archived;
}

async function putNdjson(bucket: R2Bucket, key: string, rows: unknown[]): Promise<void> {
  const body = new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const sha256 = Array.from(sha, (b) => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(rows.length), sha256 },
    sha256,
  });
}
