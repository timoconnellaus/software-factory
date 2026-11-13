// Retention (AGENTS.md "Cloudflare cost", rule 3): expired rows go in bounded batches, an intake
// event keeps its id forever, and nothing that isn't due is touched.
import { env } from "cloudflare:workers";
import { invoke } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { invokeDeps } from "../src/deps.ts";
import {
  ARCHIVE,
  archiveBudget,
  archiveRunEvents,
  archiveStatus,
  cutChunk,
  eventsChunkKey,
  pruneExpired,
  runArchivePrefix,
  sampleArchive,
} from "../src/retention.ts";
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

  it("keeps the session mode on the run, so an archived stream run is still a chat", async () => {
    const { w, workItemId, runId } = await claimedRun();
    await seedEvents(runId, 3, { startedMode: "stream" });
    await env.DB.prepare("UPDATE core_runs SET session_mode = NULL WHERE id = ?").bind(runId).run();
    await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 });
    const run = await first<{ session_mode: string | null; events_archived_at: string | null }>(
      "SELECT session_mode, events_archived_at FROM core_runs WHERE id = ?",
      runId,
    );
    expect(run).toEqual({ session_mode: "stream", events_archived_at: expect.any(String) });
    const live = await ok<{ run: { mode: string | null } }>("run.live", { workItemId }, w.human);
    expect(live.run.mode).toBe("stream");
  });

  it("budgets each tick from the rows coming due and the drain's monthly budget, giving way to live jobs", async () => {
    // A quiet day (nothing due, nobody logging) far ahead: the drain's budget paced over the
    // month's days left, plus nothing for inflow.
    const quietAt = new Date(Date.UTC(2031, 0, 1));
    const quiet = await archiveBudget(env.DB, quietAt);
    expect(quiet.busyJobs).toBe(0);
    expect(quiet.drainRowsPerDay).toBeCloseTo(
      ARCHIVE.drainWritesPerMonth / 31 / ARCHIVE.writesPerRow,
      0,
    );
    // Runs that ended in the day before the cutoff add inflow, by the rows a run has had.
    await env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES ('archive:rows-per-run', '10000') ON CONFLICT (key) DO UPDATE SET value = '10000'",
    ).run();
    const { runId } = await claimedRun();
    const now = new Date(Date.UTC(2031, 5, 1));
    await env.DB.prepare("UPDATE core_runs SET status = 'failed', ended_at = ? WHERE id = ?")
      .bind(new Date(now.getTime() - 30.5 * DAY).toISOString(), runId)
      .run();
    expect((await archiveBudget(env.DB, now)).inflowRowsPerDay).toBe(ARCHIVE.inflowFactor * 10_000);
    // A month's drain budget spent: no drain until the next month.
    await env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES ('archive:state', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(
        JSON.stringify({ month: "2031-06", drainWrites: ARCHIVE.drainWritesPerMonth, credit: 0 }),
      )
      .run();
    expect((await archiveBudget(env.DB, now)).drainRowsPerDay).toBe(0);
    expect(
      (await archiveBudget(env.DB, new Date(Date.UTC(2031, 6, 1)))).drainRowsPerDay,
    ).toBeGreaterThan(0);
    await env.DB.prepare(
      "DELETE FROM core_meta WHERE key IN ('archive:state', 'archive:rows-per-run')",
    ).run();
  });

  it("gives way to busy jobs: live, inflow and drain stay under the ceiling; six leave it nothing", async () => {
    const at = new Date();
    const base = await archiveBudget(env.DB, at);
    const runs = await Promise.all([0, 1, 2, 3].map(() => claimedRun()));
    await env.DB.batch(
      runs.map(({ runId }) =>
        env.DB.prepare(
          "UPDATE core_runs SET status = 'running', last_event_at = ? WHERE id = ?",
        ).bind(at.toISOString(), runId),
      ),
    );
    const busy = await archiveBudget(env.DB, at);
    expect(busy.busyJobs).toBeGreaterThanOrEqual(base.busyJobs + 4);
    expect(busy.liveWritesPerDay).toBe(busy.busyJobs * ARCHIVE.busyJobWritesPerDay);
    // Live, inflow and drain together stay under the ceiling: the drain takes what's left.
    expect(busy.drainRowsPerDay).toBeLessThan(base.drainRowsPerDay);
    expect(
      busy.liveWritesPerDay + (busy.drainRowsPerDay + busy.inflowRowsPerDay) * ARCHIVE.writesPerRow,
    ).toBeLessThanOrEqual(ARCHIVE.monthlyWriteCeiling / 30 + 1);
    // Six busy jobs (1.56M rows written a day) leave it nothing.
    const more = await Promise.all([0, 1].map(() => claimedRun()));
    runs.push(...more);
    await env.DB.batch(
      more.map(({ runId }) =>
        env.DB.prepare(
          "UPDATE core_runs SET status = 'running', last_event_at = ? WHERE id = ?",
        ).bind(at.toISOString(), runId),
      ),
    );
    expect((await archiveBudget(env.DB, at)).drainRowsPerDay).toBe(0);
    await env.DB.batch(
      runs.map(({ runId }) =>
        env.DB.prepare(
          "UPDATE core_runs SET status = 'failed', last_event_at = NULL WHERE id = ?",
        ).bind(runId),
      ),
    );
    // The daily status says how long the drain takes at today's rate.
    const status = await archiveStatus(env.DB, at);
    expect(status.drainRowsPerDay).toBeGreaterThanOrEqual(0);
    expect(status).toHaveProperty("expectedDrainDays");
  });

  it("cuts a chunk before it passes 1 MB, one row at least", () => {
    const row = (kb: number) => ({ payload: "x".repeat(kb * 1000) });
    expect(cutChunk([row(600), row(600)]).length).toBe(1);
    expect(cutChunk([row(300), row(300), row(300), row(300)]).length).toBe(3);
    expect(cutChunk([row(1500)]).length).toBe(1);
  });
});

/** Ends the run 31 days ago with stored rows seq 1..n, one event each (session.started at 1). */
async function seedEvents(runId: string, n: number, opts: { startedMode?: string } = {}) {
  await env.DB.batch([
    env.DB.prepare("UPDATE core_runs SET status = 'handed_back', ended_at = ? WHERE id = ?").bind(
      iso(31 * DAY),
      runId,
    ),
    ...Array.from({ length: n }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO core_run_events (run_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        runId,
        i + 1,
        iso(31 * DAY),
        i === 0 && opts.startedMode ? "session.started" : "agent.status",
        JSON.stringify(
          i === 0 && opts.startedMode ? { mode: opts.startedMode } : { status: `s${i + 1}` },
        ),
      ),
    ),
  ]);
}

/**
 * Every seq 1..n is in D1 or in exactly one recorded chunk whose object holds it, and every
 * recorded object exists and holds its range.
 */
async function expectNothingLost(runId: string, n: number) {
  const inD1 = new Set(
    (await all<{ seq: number }>("SELECT seq FROM core_run_events WHERE run_id = ?", runId)).map(
      (r) => r.seq,
    ),
  );
  const chunks = await all<{ first_seq: number; last_seq: number; r2_key: string; rows: number }>(
    "SELECT first_seq, last_seq, r2_key, rows FROM core_run_archive_chunks WHERE run_id = ? AND first_seq >= 0",
    runId,
  );
  const seen = new Map<number, number>();
  for (const c of chunks) {
    const object = await env.ARCHIVE.get(c.r2_key);
    expect(object, c.r2_key).not.toBeNull();
    const held = ((await object?.text()) ?? "")
      .split("\n")
      .filter((l) => l)
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(held.length).toBe(c.rows);
    expect(held[0]).toBe(c.first_seq);
    for (const seq of held) seen.set(seq, (seen.get(seq) ?? 0) + 1);
  }
  for (let seq = 1; seq <= n; seq++) {
    const archived = seen.get(seq) ?? 0;
    // In D1 and not archived, or archived exactly once and gone from D1.
    expect({ seq, inD1: inD1.has(seq), archived }).toEqual({
      seq,
      inD1: archived === 0,
      archived: inD1.has(seq) ? 0 : 1,
    });
  }
}

describe("archiving safely", () => {
  it("overlapping ticks with different chunk sizes: one takes the run, the other skips, nothing is lost", async () => {
    const { runId } = await claimedRun();
    await seedEvents(runId, 6);
    const [a, b] = await Promise.all([
      archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 4 }),
      archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 }),
    ]);
    expect(a + b).toBeGreaterThanOrEqual(6);
    await expectNothingLost(runId, 6);
    // A rerun finishes whatever is left, and the lease is gone with the mark.
    await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 3 });
    await expectNothingLost(runId, 6);
    expect(await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).toEqual([]);
    expect(await all("SELECT 1 FROM core_run_archive_leases WHERE run_id = ?", runId)).toEqual([]);
  });

  it("a run another tick holds is skipped until its lease expires", async () => {
    const { runId } = await claimedRun();
    await seedEvents(runId, 3);
    await env.DB.prepare(
      "INSERT INTO core_run_archive_leases (run_id, holder, expires_at) VALUES (?, 'other', ?)",
    )
      .bind(runId, new Date(Date.now() + 60_000).toISOString())
      .run();
    // Older due runs from other tests come first; archive until this one is reached or blocked.
    for (let i = 0; i < 20; i++) await archiveRunEvents(env, new Date(), { rows: 1000 });
    expect((await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).length).toBe(3);
    await env.DB.prepare("UPDATE core_run_archive_leases SET expires_at = ? WHERE run_id = ?")
      .bind(new Date(Date.now() - 1).toISOString(), runId)
      .run();
    await archiveRunEvents(env, new Date(), { rows: 1000 });
    await expectNothingLost(runId, 3);
    expect(await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).toEqual([]);
  });

  it("a crash between put and delete: the rerun finds the object, checks it and uses it", async () => {
    const { w, runId, workItemId } = await claimedRun();
    await seedEvents(runId, 4);
    const prefix = runArchivePrefix(workItemId, runId);
    // The dead tick's put of rows 1-2, exactly as the archiver writes it.
    const rows = await all(
      "SELECT seq, last_seq, at, type, payload FROM core_run_events WHERE run_id = ? AND seq <= 2 ORDER BY seq",
      runId,
    );
    await putLikeArchiver(eventsChunkKey(prefix, 1, 2), rows);
    await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 });
    await expectNothingLost(runId, 4);
    expect(
      await all(
        "SELECT first_seq, r2_key FROM core_run_archive_chunks WHERE run_id = ? AND first_seq = 1",
        runId,
      ),
    ).toEqual([{ first_seq: 1, r2_key: eventsChunkKey(prefix, 1, 2) }]);
    const live = await ok<{ events: { seq: number }[] }>(
      "run.live",
      { workItemId, afterSeq: 0 },
      w.human,
    );
    expect(live.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("a crash after a put of another chunking: the keys differ, the rerun loses nothing", async () => {
    const { runId, workItemId } = await claimedRun();
    await seedEvents(runId, 6);
    const prefix = runArchivePrefix(workItemId, runId);
    const rows = await all(
      "SELECT seq, last_seq, at, type, payload FROM core_run_events WHERE run_id = ? AND seq <= 4 ORDER BY seq",
      runId,
    );
    await putLikeArchiver(eventsChunkKey(prefix, 1, 4), rows);
    await archiveRunEvents(env, new Date(), { rows: 100, chunkRows: 2 });
    await expectNothingLost(runId, 6);
    expect(await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).toEqual([]);
  });

  it("an object at the key that doesn't match its checksum stops the tick and deletes nothing", async () => {
    const { runId, workItemId } = await claimedRun();
    await seedEvents(runId, 2);
    const key = eventsChunkKey(runArchivePrefix(workItemId, runId), 1, 2);
    await env.ARCHIVE.put(key, "garbage\n", { customMetadata: { sha256: "0".repeat(64) } });
    for (let i = 0; i < 20; i++)
      await archiveRunEvents(env, new Date(), { rows: 1000, chunkRows: 2 });
    expect((await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).length).toBe(2);
    expect(await all("SELECT 1 FROM core_run_archive_chunks WHERE run_id = ?", runId)).toEqual([]);
    // Left for a person: the run is moved out of the way so later tests' runs come due.
    await env.DB.prepare("UPDATE core_runs SET ended_at = NULL WHERE id = ?").bind(runId).run();
  });

  it("run.live reads across the boundary of a run part-way archived, with no loss or duplicates", async () => {
    const { w, runId, workItemId } = await claimedRun();
    await seedEvents(runId, 9);
    // Drain anything older, then archive this run's first 4 rows only (2 chunks of 2).
    for (let i = 0; i < 20; i++) {
      const due = await first<{ id: string }>(
        "SELECT id FROM core_runs WHERE ended_at IS NOT NULL AND events_archived_at IS NULL AND ended_at < ? ORDER BY ended_at LIMIT 1",
        iso(30 * DAY),
      );
      if (!due || due.id === runId) break;
      await archiveRunEvents(env, new Date(), { rows: 1000 });
    }
    await archiveRunEvents(env, new Date(), { rows: 4, chunkRows: 2 });
    expect((await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).length).toBe(5);
    type Live = { events: { seq: number }[]; lastSeq: number; archived: boolean };
    const newest = await ok<Live>("run.live", { workItemId }, w.human);
    expect(newest.events.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    const seqs: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const page = await ok<Live>("run.live", { workItemId, afterSeq: cursor }, w.human);
      if (page.events.length === 0) break;
      seqs.push(...page.events.map((e) => e.seq));
      cursor = page.lastSeq;
      // The archiver moves the next chunk while the reader is part-way: still no gap, no repeat.
      if (i === 0) await archiveRunEvents(env, new Date(), { rows: 2, chunkRows: 2 });
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("a missing object reads as missing and a failed read as failed, never as an empty run", async () => {
    const { w, runId, workItemId } = await claimedRun();
    await seedEvents(runId, 2);
    for (let i = 0; i < 20; i++) {
      await archiveRunEvents(env, new Date(), { rows: 1000 });
      const r = await first<{ a: string | null }>(
        "SELECT events_archived_at AS a FROM core_runs WHERE id = ?",
        runId,
      );
      if (r?.a) break;
    }
    type Live = { events: unknown[]; archive: string | null; archived: boolean };
    expect((await ok<Live>("run.live", { workItemId }, w.human)).archive).toBe("read");
    // R2 failing: `failed`, to try again.
    const deps = invokeDeps(env);
    const failing = {
      ...deps,
      services: {
        ...deps.services,
        runArchive: {
          get: async () => Promise.reject(new Error("R2 down")),
          exists: async () => true,
        },
      },
    };
    const failed = await invoke<Live>(
      failing,
      "run.live",
      { workItemId },
      { actor: w.human, origin: { surface: "test" } },
    );
    expect(failed.status === "ok" && failed.output).toEqual(
      expect.objectContaining({ archive: "failed", events: [], archived: true }),
    );
    // The object gone (read past the isolate's cache, which would still hold it): `missing`.
    const chunk = await first<{ r2_key: string }>(
      "SELECT r2_key FROM core_run_archive_chunks WHERE run_id = ? AND first_seq >= 0",
      runId,
    );
    await env.ARCHIVE.delete(chunk?.r2_key ?? "");
    const uncached = {
      ...deps,
      services: {
        ...deps.services,
        runArchive: {
          get: async (key: string) => (await env.ARCHIVE.get(key))?.text() ?? null,
          exists: async (key: string) => (await env.ARCHIVE.head(key)) !== null,
        },
      },
    };
    const missing = await invoke<Live>(
      uncached,
      "run.live",
      { workItemId, afterSeq: 0 },
      { actor: w.human, origin: { surface: "test" } },
    );
    expect(missing.status === "ok" && missing.output).toEqual(
      expect.objectContaining({ archive: "missing", events: [] }),
    );
  });
});

describe("a lost archive object is an incident for a person", () => {
  /** An archived run of 2 events (one chunk), with the chunk's rowid and key. */
  async function archivedRun() {
    const ctx = await claimedRun();
    await seedEvents(ctx.runId, 2);
    for (let i = 0; i < 30; i++) {
      await archiveRunEvents(env, new Date(), { rows: 1000 });
      const r = await first<{ a: string | null }>(
        "SELECT events_archived_at AS a FROM core_runs WHERE id = ?",
        ctx.runId,
      );
      if (r?.a) break;
    }
    const chunk = await first<{ rowid: number; r2_key: string; first_seq: number }>(
      "SELECT rowid, r2_key, first_seq FROM core_run_archive_chunks WHERE run_id = ? AND first_seq >= 0",
      ctx.runId,
    );
    if (!chunk) throw new Error("not archived");
    return { ...ctx, chunk };
  }
  type Report = {
    reported: boolean;
    incident: { id: string; openedAt: string; resolvedAt: string | null } | null;
  };

  it("checks for itself, records one incident per run, with no work item to release", async () => {
    const { w, workItemId, runId, chunk } = await archivedRun();
    const report = (firstSeq: number) =>
      ok<Report>("run.reportArchiveMissing", { workItemId, runId, firstSeq }, w.human);
    // The object is there: nothing happens, whatever the caller says.
    expect(await report(chunk.first_seq)).toEqual({ reported: false, incident: null });
    // A chunk the index doesn't name: nothing.
    expect(await report(999)).toEqual({ reported: false, incident: null });
    await env.ARCHIVE.delete(chunk.r2_key);
    const items = async () =>
      (await first<{ n: number }>("SELECT count(*) AS n FROM core_work_items"))?.n;
    const before = await items();
    const opened = await report(chunk.first_seq);
    expect(opened.reported).toBe(true);
    // A record for a person and nothing else: no work item (so nothing to release into the
    // incident workflow, whose fixes can auto-merge), no job.
    expect(await items()).toBe(before);
    expect(
      await all<{ kind: string; fix_work_item_id: string | null; resolved_at: string | null }>(
        "SELECT kind, fix_work_item_id, resolved_at FROM core_incidents WHERE run_id = ?",
        runId,
      ),
    ).toEqual([{ kind: "archive_missing", fix_work_item_id: null, resolved_at: null }]);
    // Again (another viewer): the same incident, no second one.
    expect(await report(chunk.first_seq)).toEqual({ reported: false, incident: opened.incident });
    expect((await all("SELECT 1 FROM core_incidents WHERE run_id = ?", runId)).length).toBe(1);
    // run.live names it, past the isolate's cache.
    const deps = invokeDeps(env);
    const uncached = {
      ...deps,
      services: {
        ...deps.services,
        runArchive: {
          get: async (key: string) => (await env.ARCHIVE.get(key))?.text() ?? null,
          exists: async (key: string) => (await env.ARCHIVE.head(key)) !== null,
        },
      },
    };
    const live = await invoke<{ archiveMissing: unknown }>(
      uncached,
      "run.live",
      { workItemId, afterSeq: 0 },
      { actor: w.human, origin: { surface: "test" } },
    );
    expect(live.status === "ok" && live.output.archiveMissing).toEqual({
      firstSeq: chunk.first_seq,
      incident: opened.incident,
    });
  });

  it("is listed for the org until a person resolves it, once, with what they did", async () => {
    const { w, workItemId, runId, chunk } = await archivedRun();
    await env.ARCHIVE.delete(chunk.r2_key);
    const opened = await ok<Report>(
      "run.reportArchiveMissing",
      { workItemId, runId, firstSeq: chunk.first_seq },
      w.human,
    );
    const id = opened.incident?.id ?? "";
    const list = () =>
      ok<{ incidents: { id: string; workItemId: string; runId: string | null }[]; more: boolean }>(
        "incident.listArchiveMissing",
        { orgId: w.orgId },
        w.human,
      );
    expect((await list()).incidents).toContainEqual(
      expect.objectContaining({ id, workItemId, runId }),
    );
    // The item's runs say where the log is.
    const detail = await ok<{ runs: { id: string; log: string; archiveIncident: unknown }[] }>(
      "workItem.get",
      { workItemId },
      w.human,
    );
    expect(detail.runs.find((r) => r.id === runId)).toMatchObject({
      log: "missing",
      archiveIncident: { id, resolvedAt: null },
    });
    expect(
      await ok(
        "incident.resolve",
        { workItemId, incidentId: id, resolution: "lost, accepted" },
        w.human,
      ),
    ).toEqual({ resolved: true });
    expect(
      await ok("incident.resolve", { workItemId, incidentId: id, resolution: "again" }, w.human),
    ).toEqual({ resolved: false });
    expect((await list()).incidents.map((i) => i.id)).not.toContain(id);
    const row = await first<{ resolution: string; resolved_by: string }>(
      "SELECT resolution, resolved_by FROM core_incidents WHERE id = ?",
      id,
    );
    expect(row).toEqual({ resolution: "lost, accepted", resolved_by: w.human.id });
  });

  it("the daily sample finds a lost object with a HEAD and opens its incident", async () => {
    const { runId, chunk } = await archivedRun();
    await env.ARCHIVE.delete(chunk.r2_key);
    const top = await first<{ top: number }>(
      "SELECT max(rowid) AS top FROM core_run_archive_chunks",
    );
    const at = (chunk.rowid - 1 + 0.5) / (top?.top ?? 1);
    expect(await sampleArchive(env, new Date(), 1, () => at)).toEqual([chunk.r2_key]);
    expect(
      await all<{ kind: string }>("SELECT kind FROM core_incidents WHERE run_id = ?", runId),
    ).toEqual([{ kind: "archive_missing" }]);
    // An object that is there is left alone.
    const fine = await archivedRun();
    const top2 = await first<{ top: number }>(
      "SELECT max(rowid) AS top FROM core_run_archive_chunks",
    );
    const at2 = (fine.chunk.rowid - 1 + 0.5) / (top2?.top ?? 1);
    expect(await sampleArchive(env, new Date(), 1, () => at2)).toEqual([]);
  });
});

async function putLikeArchiver(key: string, rows: unknown[]) {
  const body = new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.ARCHIVE.put(key, body, { customMetadata: { rows: String(rows.length), sha256: sha } });
}
