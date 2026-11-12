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
//   core_run_events, _steers     archived with their read path (a later change)

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
