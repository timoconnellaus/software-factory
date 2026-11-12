// Every hot path's queries use an index (AGENTS.md, "Cloudflare cost", rule 1): each scenario runs a
// path through the real code against the migrated schema, and fails if any statement it ran plans a
// SCAN of a growing table. To guard another path, add a scenario to HOT_PATHS.
import { env } from "cloudflare:workers";
import {
  invoke,
  r2AttachmentBlobs,
  recentOutcomes,
  sweepStrayAttachmentBlobs,
} from "@software-factory/core";
import { createDb } from "@software-factory/db";
import { httpControlPlane, runnerChannelKey } from "@software-factory/runner-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { invokeDeps } from "../src/deps.ts";
import worker, { pruneCheckResults } from "../src/index.ts";
import { pruneReconcileShadow, SHADOW_LAG_MS, shadowPass } from "../src/reconcile-shadow.ts";
import { pruneExpired } from "../src/retention.ts";
import { MANIFEST, ok, uid, type World, world } from "./helpers.ts";
import { growingScans, type Recorded, recordingEnv } from "./query-plans.ts";

let w: World;
let job: { jobId: string; fencingToken: number } | null = null;

async function channel(e: Env, runnerId: string) {
  return httpControlPlane({
    baseUrl: "https://sf-engine.example",
    runnerId,
    key: await runnerChannelKey("test-channel-secret", runnerId, 1),
    fetch: async (input, init) => worker.fetch(new Request(input, init), e),
  });
}

const as = (e: Env, op: string, input: unknown, actor: World["human"]) =>
  invoke(invokeDeps(e), op, input, { actor, origin: { surface: "test" } });

/** The latest past minute :17 (a future one would expire the test's live lease). */
function minute17(): number {
  const d = new Date();
  d.setUTCMinutes(17, 0, 0);
  return d.getTime() > Date.now() ? d.getTime() - 3_600_000 : d.getTime();
}

/** The registered hot paths: each runs once, then every statement it ran is EXPLAINed. */
const HOT_PATHS: { name: string; run: (e: Env) => Promise<unknown> }[] = [
  {
    // The minute cron, on the minute that also sweeps attachment blobs and runs the improver.
    name: "the minute cron",
    run: (e) => worker.scheduled({ scheduledTime: minute17(), cron: "* * * * *", noRetry() {} }, e),
  },
  {
    name: "runner heartbeat (signed channel: authenticate, idempotency, operation)",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).heartbeat({
        manifest: MANIFEST,
        capacity: { max: 2, inUse: job ? 1 : 0, accepting: true },
        activeJobs: job ? [{ jobId: job.jobId, fencingToken: job.fencingToken }] : [],
      }),
  },
  {
    name: "job.claim with nothing to claim",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
      }),
  },
  {
    name: "job.claim with a queued job",
    run: async (e) => {
      await ok(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title: "Plan me" },
        w.human,
      );
      return (await channel(e, w.runner.runnerId)).claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
      });
    },
  },
  {
    name: "the held steer poll (run.takeSteers)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).steers?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 0,
      });
    },
  },
  {
    // Every planning call finds its session by the job. The test's job is dressed as a planning
    // run for the call, so the real lookup runs (and is refused: there is no session).
    name: "a planning call's session lookup",
    run: async (e) => {
      if (!job) return null;
      const stage = (sql: string) => env.DB.prepare(sql).bind(job?.jobId).run();
      const was = await env.DB.prepare("SELECT stage FROM core_runs WHERE job_id = ?")
        .bind(job.jobId)
        .first<string>("stage");
      await stage("UPDATE core_runs SET stage = 'planning' WHERE job_id = ?");
      try {
        return await as(e, "planning.wait", { ...job, timeoutMs: 0 }, w.runnerActor).catch(
          (error: { message?: string }) => {
            if (!/planning session is over/.test(error.message ?? "")) throw error;
          },
        );
      } finally {
        await env.DB.prepare("UPDATE core_runs SET stage = ? WHERE job_id = ?")
          .bind(was, job.jobId)
          .run();
      }
    },
  },
  { name: "inbox.list (polled)", run: (e) => as(e, "inbox.list", {}, w.human) },
  {
    name: "workItem.list by org (polled)",
    run: (e) => as(e, "workItem.list", { orgId: w.orgId }, w.human),
  },
  {
    name: "workItem.list by project (polled)",
    run: (e) => as(e, "workItem.list", { projectId: w.projectId }, w.human),
  },
  {
    name: "workItem.list by project and status",
    run: (e) =>
      as(e, "workItem.list", { projectId: w.projectId, status: ["queued", "running"] }, w.human),
  },
  {
    // The improver's history of finished items (improve.scan, config.trial.resolve).
    name: "recentOutcomes",
    run: (e) => recentOutcomes(createDb(e.DB), w.projectId, { limit: 10 }),
  },
  {
    // Every five minutes: the shadow reconciler (spec 52 PR (c)) reads the items that ended since its
    // cursor, with one to read: an ended item with its stages and a packet the queue carried.
    name: "the shadow reconciler's pass",
    run: async (e) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "backlog", projectId: w.projectId, title: "Ended" },
        w.human,
      );
      const id = item.workItemId;
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO core_stages (id, work_item_id, stage, attempt, status, started_at) VALUES (?, ?, 'triage', 1, 'done', ?)",
        ).bind(`st_${id}`, id, at),
        env.DB.prepare(
          "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES (?, ?, 'b2', 'pass', '{\"carriedFrom\":\"a1\"}', ?)",
        ).bind(`rp_${id}`, id, at),
        env.DB.prepare(
          "UPDATE core_work_items SET status = 'done', size = 'small', updated_at = ? WHERE id = ?",
        ).bind(at, id),
      ]);
      const read = await shadowPass(e, new Date(Date.now() + SHADOW_LAG_MS + 60_000));
      if (read === 0) throw new Error("the pass read no ended item");
      return read;
    },
  },
  {
    name: "the shadow reconciler's prune",
    run: (e) => pruneReconcileShadow(e, new Date()),
  },
  {
    // The hourly stray-blob sweep with a blob to check (an empty bucket runs no D1 query).
    name: "the attachment sweep",
    run: async (e) => {
      await env.ATTACHMENTS.put(`${w.orgId}/plans/att_plan`, new Uint8Array([1]));
      return sweepStrayAttachmentBlobs(
        e.DB,
        r2AttachmentBlobs(env.ATTACHMENTS),
        new Date(Date.now() + 2 * 3_600_000),
      );
    },
  },
  {
    // The hourly check results prune (ADR 0501, fifth review), with a row past its cutoff to read.
    name: "the check results prune",
    run: async (e) => {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO core_check_results
           (work_item_id, head_sha, name, run_id, command, exit_code, timed_out, duration_ms,
            log_tail, round, created_at)
         SELECT work_item_id, ?, 'plan-guard', id, 'true', 0, 0, 1, '', 0, '2000-01-01T00:00:00.000Z'
         FROM core_runs WHERE job_id = ?`,
      )
        .bind("a".repeat(40), job?.jobId ?? "")
        .run();
      // Its item is open, so the row is read, looked up and kept; limit 1 moves the cursor.
      return pruneCheckResults(e.DB, new Date(), 1);
    },
  },
  {
    name: "the hourly prunes (retention)",
    run: (e) => pruneExpired(e.DB, new Date()),
  },
];

describe("hot-path query plans (AGENTS.md, Cloudflare cost)", () => {
  beforeAll(async () => {
    w = await world();
    // A running job, so the heartbeat and steer paths carry one.
    await ok("workItem.create", { state: "queued", projectId: w.projectId, title: "Run" }, w.human);
    const c = await channel(env, w.runner.runnerId);
    for (let i = 0; i < 100 && !job; i++) {
      const claimed = await c.claim({
        claimId: uid("claim-"),
        manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "steer"] },
        capacity: { max: 4, inUse: 0, accepting: true },
      });
      if (claimed.job) {
        job = { jobId: claimed.job.jobId, fencingToken: claimed.job.lease.fencingToken };
      } else await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job to run the heartbeat and steer paths with");
  });

  it("catches a scan (the guard itself works)", async () => {
    const seen: Recorded[] = [];
    await recordingEnv(env, seen)
      .DB.prepare("SELECT id FROM core_audit a WHERE a.outcome = ? LIMIT 1")
      .bind("ok")
      .first();
    expect(await growingScans(env.DB, seen)).toEqual([
      expect.objectContaining({ table: "core_audit", detail: "SCAN a" }),
    ]);
  });

  it("a status-filtered list reads only that status's rows (no walk of every item)", async () => {
    const seen: Recorded[] = [];
    await as(
      recordingEnv(env, seen),
      "workItem.list",
      { projectId: w.projectId, status: ["queued"] },
      w.human,
    );
    const list = seen.find(
      (r) => /from "core_work_items"/.test(r.sql) && /"status" in/.test(r.sql),
    );
    if (!list) throw new Error("the list query didn't run");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${list.sql}`)
      .bind(...list.params)
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(/USING INDEX \w+ \(status=\?/);
  });

  it("job.claim reads the queue in claim order from its index: no sort of the queued jobs", async () => {
    const seen: Recorded[] = [];
    await (await channel(recordingEnv(env, seen), w.runner.runnerId)).claim({
      claimId: uid("claim-"),
      manifest: MANIFEST,
      capacity: { max: 2, inUse: 0, accepting: true },
    });
    const claim = seen.find((r) => /WITH q AS/.test(r.sql));
    if (!claim) throw new Error("the claim query didn't run");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${claim.sql}`)
      .bind(...claim.params)
      .all<{ id: number; parent: number; detail: string }>();
    // The CTE q: core_jobs through core_jobs_queue_idx, and no temp B-tree under it.
    const q = results.find((r) => /^(MATERIALIZE|CO-ROUTINE) q$/.test(r.detail));
    if (!q) throw new Error(`no q in the plan:\n${results.map((r) => r.detail).join("\n")}`);
    const under = results.filter((r) => r.parent === q.id).map((r) => r.detail);
    expect(under.join("\n")).toMatch(/core_jobs_queue_idx/);
    expect(under.join("\n")).not.toMatch(/TEMP B-TREE/);
  });

  for (const path of HOT_PATHS) {
    it(`${path.name}: no SCAN of a growing table`, async () => {
      const seen: Recorded[] = [];
      await path.run(recordingEnv(env, seen));
      expect(seen.length).toBeGreaterThan(0);
      expect(await growingScans(env.DB, seen)).toEqual([]);
    });
  }
});
