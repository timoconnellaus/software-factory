// Retention (AGENTS.md "Cloudflare cost", rule 3): expired rows go in bounded batches, an intake
// event keeps its id forever, and nothing that isn't due is touched.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ARCHIVE, archiveBudget, archiveRunEvents, pruneExpired } from "../src/retention.ts";
import { all, first, MANIFEST, ok, uid, world } from "./helpers.ts";

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function claimedRun() {
  const w = await world();
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title: "Retention" },
    w.human,
  );
  let job: { jobId: string } | null = null;
  for (let i = 0; i < 100 && !job; i++) {
    job = (
      await ok<{ job: { jobId: string } | null }>(
        "job.claim",
        {
          claimId: uid("claim-"),
          manifest: MANIFEST,
          capacity: { max: 4, inUse: 0, accepting: true },
        },
        w.runnerActor,
      )
    ).job;
    if (!job) await new Promise((r) => setTimeout(r, 50));
  }
  if (!job) throw new Error("no job");
  const run = await first<{ id: string }>("SELECT id FROM core_runs WHERE job_id = ?", job.jobId);
  if (!run) throw new Error("no run");
  return { w, workItemId: item.workItemId, runId: run.id };
}

describe("pruneExpired", () => {
  it("deletes only rows past their period, at most a batch per table per tick", async () => {
    const { w, workItemId, runId } = await claimedRun();
    const tag = uid("");
    const stmts = [
      ...[40, 40, 40, 1].map((days, i) =>
        env.DB.prepare(
          "INSERT INTO core_connector_events (provider, delivery_id, event, received_at) VALUES ('github', ?, 'push', ?)",
        ).bind(`${tag}-${i}`, iso(days * DAY)),
      ),
      ...[100, 10].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_intake_events (event_id, dedupe_key, work_item_id, outcome, source, title, body, actor_id, received_at)
           VALUES (?, ?, ?, 'created', 'test', 't', 'kept', 'a', ?)`,
        ).bind(`${tag}-ie-${i}`, `${tag}-dk-${i}`, workItemId, iso(days * DAY)),
      ),
      ...[100, 10].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_run_terminal_attaches (id, run_id, work_item_id, user_id, mode, opened_at)
           VALUES (?, ?, ?, ?, 'watch', ?)`,
        ).bind(`ta_${tag}${i}`, runId, workItemId, w.userId, iso(days * DAY)),
      ),
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_runner_device_codes (id, device_code_hash, user_code, status, created_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        ).bind(`rdc_${tag}${i}`, `h-${tag}-${i}`, `U-${tag}-${i}`, iso(3 * DAY), iso(days * DAY)),
      ),
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_cli_device_codes (id, device_code_hash, user_code, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`cdc_${tag}${i}`, `h-${tag}-${i}`, `C-${tag}-${i}`, iso(3 * DAY), iso(days * DAY)),
      ),
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_github_connect_states (state_hash, org_id, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`s-${tag}-${i}`, w.orgId, w.userId, iso(3 * DAY), iso(days * DAY)),
      ),
    ];
    await env.DB.batch(stmts);

    // Batches of 2, one round a tick: two of the three old webhook deliveries go now, the third
    // next tick; with more rounds a tick, a full batch goes round again.
    const firstTick = await pruneExpired(env.DB, new Date(), 2, 1);
    expect(firstTick.core_connector_events).toBe(2);
    await pruneExpired(env.DB, new Date(), 2, 1);
    const left = async (sql: string, ...p: unknown[]) => (await all(sql, ...p)).length;
    expect(
      await left("SELECT 1 FROM core_connector_events WHERE delivery_id LIKE ?", `${tag}-%`),
    ).toBe(1);
    // Intake events stay (the dedupe of event ids); the old one's body is cleared.
    expect(
      await all(
        "SELECT event_id, body FROM core_intake_events WHERE event_id LIKE ? ORDER BY event_id",
        `${tag}-ie-%`,
      ),
    ).toEqual([
      { event_id: `${tag}-ie-0`, body: "" },
      { event_id: `${tag}-ie-1`, body: "kept" },
    ]);
    expect(
      await left("SELECT 1 FROM core_run_terminal_attaches WHERE id LIKE ?", `ta_${tag}%`),
    ).toBe(1);
    expect(
      await left("SELECT 1 FROM core_runner_device_codes WHERE id LIKE ?", `rdc_${tag}%`),
    ).toBe(1);
    expect(await left("SELECT 1 FROM core_cli_device_codes WHERE id LIKE ?", `cdc_${tag}%`)).toBe(
      1,
    );
    expect(
      await left("SELECT 1 FROM core_github_connect_states WHERE state_hash LIKE ?", `s-${tag}-%`),
    ).toBe(1);
  });
});

describe("pruneExpired rounds", () => {
  it("goes round again while a table fills its batch, up to the rounds a tick allows", async () => {
    const tag = uid("");
    await env.DB.batch(
      Array.from({ length: 7 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO core_connector_events (provider, delivery_id, event, received_at) VALUES ('github', ?, 'push', ?)",
        ).bind(`${tag}-r${i}`, iso(40 * DAY)),
      ),
    );
    const left = async () =>
      (await all("SELECT 1 FROM core_connector_events WHERE delivery_id LIKE ?", `${tag}-r%`))
        .length;
    // Batches of 2, at most 3 rounds: 6 this tick, the last one next tick.
    await pruneExpired(env.DB, new Date(), 2, 3);
    expect(await left()).toBe(1);
    await pruneExpired(env.DB, new Date(), 2, 3);
    expect(await left()).toBe(0);
  });
});

describe("archiveRunEvents and the read path", () => {
  it("moves an ended run's events and steers to R2, records each chunk, and run.live reads them back", async () => {
    const { w, workItemId, runId } = await claimedRun();
    const lines = (from: number, n: number) =>
      JSON.stringify({
        lines: Array.from({ length: n }, (_, i) => ({
          seq: from + i,
          at: iso(31 * DAY),
          stream: "terminal",
          text: `line ${from + i}`,
        })),
      });
    await env.DB.batch([
      env.DB.prepare("UPDATE core_runs SET status = 'handed_back', ended_at = ? WHERE id = ?").bind(
        iso(31 * DAY),
        runId,
      ),
      env.DB.prepare(
        "INSERT INTO core_run_events (run_id, seq, at, type, payload) VALUES (?, 1, ?, 'job.state', ?)",
      ).bind(runId, iso(31 * DAY), JSON.stringify({ state: "running" })),
      env.DB.prepare(
        "INSERT INTO core_run_events (run_id, seq, last_seq, at, type, payload) VALUES (?, 2, 4, ?, 'log', ?)",
      ).bind(runId, iso(31 * DAY), lines(2, 3)),
      env.DB.prepare(
        "INSERT INTO core_run_events (run_id, seq, at, type, payload) VALUES (?, 5, ?, 'agent.status', ?)",
      ).bind(runId, iso(31 * DAY), JSON.stringify({ status: "idle" })),
      env.DB.prepare(
        "INSERT INTO core_run_events (run_id, seq, last_seq, at, type, payload) VALUES (?, 6, 7, ?, 'log', ?)",
      ).bind(runId, iso(31 * DAY), lines(6, 2)),
      env.DB.prepare(
        `INSERT INTO core_run_steers (id, run_id, work_item_id, author_user_id, text, created_at)
         VALUES (?, ?, ?, ?, 'also add tests', ?)`,
      ).bind(uid("st_"), runId, workItemId, w.userId, iso(31 * DAY)),
    ]);
    type Live = {
      archived: boolean;
      events: { seq: number; type: string; data: { text?: string } }[];
      lastSeq: number;
      steers: { text: string; authorName: string | null }[];
    };
    const before = await ok<Live>("run.live", { workItemId, runId }, w.human);
    expect(before.archived).toBe(false);

    // Not due 20 days back.
    expect(
      await archiveRunEvents(env, new Date(Date.now() - 20 * DAY), { rows: 100, chunkRows: 2 }),
    ).toBe(0);
    // Two stored rows a chunk: [1, 2-4], [5, 6-7], then the steers and the mark.
    expect(await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 })).toBe(5);
    expect(await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).toEqual([]);
    expect(await all("SELECT 1 FROM core_run_steers WHERE run_id = ?", runId)).toEqual([]);
    expect(
      await all(
        "SELECT first_seq, last_seq, rows FROM core_run_archive_chunks WHERE run_id = ? ORDER BY first_seq",
        runId,
      ),
    ).toEqual([
      { first_seq: -1, last_seq: -1, rows: 1 },
      { first_seq: 1, last_seq: 4, rows: 2 },
      { first_seq: 5, last_seq: 7, rows: 2 },
    ]);
    const mark = await first<{ events_archived_at: string | null }>(
      "SELECT events_archived_at FROM core_runs WHERE id = ?",
      runId,
    );
    expect(mark?.events_archived_at).not.toBeNull();

    // run.live reads the archive: the newest chunk first, then a chunk a page from a cursor.
    const newest = await ok<Live>("run.live", { workItemId, runId }, w.human);
    expect(newest.archived).toBe(true);
    expect(newest.events.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(newest.steers).toEqual([
      expect.objectContaining({ text: "also add tests", authorName: `gh-${w.userId}` }),
    ]);
    const page1 = await ok<Live>("run.live", { workItemId, runId, afterSeq: 0 }, w.human);
    expect(page1.events.map((e) => [e.seq, e.type, e.data.text ?? null])).toEqual([
      [1, "job.state", null],
      [2, "log", "line 2"],
      [3, "log", "line 3"],
      [4, "log", "line 4"],
    ]);
    const page2 = await ok<Live>(
      "run.live",
      { workItemId, runId, afterSeq: page1.lastSeq },
      w.human,
    );
    expect(page2.events.map((e) => e.seq)).toEqual([5, 6, 7]);
    const mid = await ok<Live>("run.live", { workItemId, runId, afterSeq: 2 }, w.human);
    expect(mid.events.map((e) => e.seq)).toEqual([3, 4]);
    // Done: nothing left due.
    expect(await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 })).toBe(0);
  });

  it("budgets each tick from the backlog's share and the rows coming due, so it always gains", async () => {
    const quiet = await archiveBudget(env.DB, new Date(Date.now() + 365 * DAY));
    expect(quiet).toBe(Math.ceil(ARCHIVE.backlogRowsPerDay / 1440));
    // Runs that ended in the day before the cutoff raise the budget, by the rows a run has had.
    await env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES ('archive:rows-per-run', '10000') ON CONFLICT (key) DO UPDATE SET value = '10000'",
    ).run();
    const { runId } = await claimedRun();
    const now = new Date(Date.now() + 400 * DAY);
    await env.DB.prepare("UPDATE core_runs SET status = 'failed', ended_at = ? WHERE id = ?")
      .bind(new Date(now.getTime() - 30.5 * DAY).toISOString(), runId)
      .run();
    expect(await archiveBudget(env.DB, now)).toBe(
      Math.ceil((ARCHIVE.backlogRowsPerDay + ARCHIVE.inflowFactor * 10_000) / 1440),
    );
  });
});
