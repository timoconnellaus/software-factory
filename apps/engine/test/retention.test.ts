// Retention (AGENTS.md "Cloudflare cost", rule 4): expired rows go in bounded batches, a run's events
// and steers go to R2 before they leave D1, and nothing that isn't due is touched.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { archiveRunEvents, pruneExpired, runArchivePrefix } from "../src/retention.ts";
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
          `INSERT INTO core_intake_events (event_id, dedupe_key, work_item_id, outcome, source, title, actor_id, received_at)
           VALUES (?, ?, ?, 'created', 'test', 't', 'a', ?)`,
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

    // A batch of 2: two of the three old webhook deliveries go now, the third next tick.
    const firstTick = await pruneExpired(env.DB, new Date(), 2);
    expect(firstTick.core_connector_events).toBe(2);
    await pruneExpired(env.DB, new Date(), 2);
    const left = async (sql: string, ...p: unknown[]) => (await all(sql, ...p)).length;
    expect(
      await left("SELECT 1 FROM core_connector_events WHERE delivery_id LIKE ?", `${tag}-%`),
    ).toBe(1);
    expect(
      await left("SELECT 1 FROM core_intake_events WHERE event_id LIKE ?", `${tag}-ie-%`),
    ).toBe(1);
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

describe("archiveRunEvents", () => {
  it("moves an ended run's events and steers to R2 in chunks, then marks the run", async () => {
    const { w, workItemId, runId } = await claimedRun();
    // Ended 31 days ago, with 5 events and a steer.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE core_runs SET status = 'handed_back', ended_at = ? WHERE id = ?",
      ).bind(iso(31 * DAY), runId),
      ...[1, 2, 3, 4, 5].map((seq) =>
        env.DB.prepare(
          "INSERT INTO core_run_events (run_id, seq, at, type, payload) VALUES (?, ?, ?, 'log', ?)",
        ).bind(runId, seq, iso(31 * DAY), JSON.stringify({ text: `line ${seq}` })),
      ),
      env.DB.prepare(
        `INSERT INTO core_run_steers (id, run_id, work_item_id, author_user_id, text, created_at)
         VALUES (?, ?, ?, ?, 'also add tests', ?)`,
      ).bind(uid("st_"), runId, workItemId, w.userId, iso(31 * DAY)),
    ]);

    // Only runs ended more than 30 days ago are due: not this one, 20 days back.
    expect(await archiveRunEvents(env, new Date(Date.now() - 20 * DAY), { chunk: 2 })).toBe(0);
    // Two chunks a tick of two events: 4 events now, then the 5th and the steer, then the mark.
    expect(await archiveRunEvents(env, new Date(), { chunk: 2, chunks: 2 })).toBe(4);
    expect(await archiveRunEvents(env, new Date(), { chunk: 2, chunks: 3 })).toBe(2);
    const runRow = await first<{ events_archived_at: string | null }>(
      "SELECT events_archived_at FROM core_runs WHERE id = ?",
      runId,
    );
    expect(runRow?.events_archived_at).not.toBeNull();
    expect(await all("SELECT 1 FROM core_run_events WHERE run_id = ?", runId)).toEqual([]);
    expect(await all("SELECT 1 FROM core_run_steers WHERE run_id = ?", runId)).toEqual([]);

    const listed = await env.ARCHIVE.list({ prefix: runArchivePrefix(workItemId, runId) });
    const keys = listed.objects.map((o) => o.key.slice(o.key.lastIndexOf("/") + 1));
    expect(keys.filter((k) => k.startsWith("events-"))).toEqual([
      "events-0000000001.ndjson",
      "events-0000000003.ndjson",
      "events-0000000005.ndjson",
    ]);
    expect(keys.filter((k) => k.startsWith("steers-"))).toHaveLength(1);
    const lines: { seq: number; payload: string }[] = [];
    for (const o of listed.objects.filter((x) => x.key.includes("/events-"))) {
      const body = await (await env.ARCHIVE.get(o.key))?.text();
      for (const line of body?.trim().split("\n") ?? []) lines.push(JSON.parse(line));
    }
    expect(lines.map((l) => l.seq).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.parse(lines[0]?.payload ?? "{}")).toEqual({ text: "line 1" });
    // Done: the run is no longer due.
    expect(await archiveRunEvents(env, new Date(), { chunk: 2 })).toBe(0);
  });
});
