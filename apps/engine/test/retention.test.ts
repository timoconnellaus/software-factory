// Retention (AGENTS.md "Cloudflare cost", rule 3): expired rows go in bounded batches, an intake
// event keeps its id forever, and nothing that isn't due is touched.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneExpired } from "../src/retention.ts";
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
