// Retention of the platform's tables that only grow (AGENTS.md "Cloudflare cost", rule 3). Each prune
// is bounded per tick and reads through an index on its time column (migrations 0040, 0060, 0110),
// so a tick with nothing due reads nothing.
//
//   table                        kept                             then
//   device codes, connect states a day past their expiry          deleted, hourly (pruneExpired)
//   core_channel_requests        a day                            deleted, every minute (channel.ts)
//   desktop and phone sign-ins,  a day past their expiry          deleted, every minute (channel.ts)
//   challenges, nonces, offers
//   flow_run_events (new core)   30 days after the run finished   deleted, every minute, by
//                                                                  pruneRunEvents (packages/store)
//   core_audit                   kept: append-only, written only when a platform call changes
//                                state (migration 0438)

const DAY = 86_400_000;

/** How long each table is kept. Changing a period is a code change, reviewed like any other. */
export const RETENTION = { expiredGraceDays: 1 } as const;

/** Rows each prune handles per round: one D1 batch (one query) covers every table. */
export const PRUNE_BATCH = 500;
/** Rounds per tick at most, while some table still fills its batch: 5,000 rows a table an hour. */
export const PRUNE_ROUNDS = 10;

/** The expiring tables and their time columns: each has an index on that column. */
const PRUNES: { table: string; column: string; days: number }[] = [
  { table: "core_runner_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_cli_device_codes", column: "expires_at", days: RETENTION.expiredGraceDays },
  { table: "core_github_connect_states", column: "expires_at", days: RETENTION.expiredGraceDays },
];

/**
 * Deletes due rows from each expiring table, `batch` rows a table a round, each round one D1 batch,
 * again while any table filled its batch, at most `rounds` times (a backlog drains over several
 * ticks). Returns the rows handled per table.
 */
export async function pruneExpired(
  db: D1Database,
  now = new Date(),
  batch = PRUNE_BATCH,
  rounds = PRUNE_ROUNDS,
): Promise<Record<string, number>> {
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const work = PRUNES.map(({ table, column, days }) => ({
    name: table,
    stmt: db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`,
      )
      .bind(cutoff(days), batch),
  }));
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
