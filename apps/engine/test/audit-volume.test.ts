// How much the machine-frequency calls write (ADR 0590): an idle runner, a running job and an open
// Planning tab, each for one of its cycles, measured in D1 rows written and audit rows, with the
// changes-only audit on (now) and off (before). The ADR's per-day figures come from this test's log.
import { env } from "cloudflare:workers";
import { getOperation, invoke } from "@software-factory/core";
import { httpControlPlane, runnerChannelKey } from "@software-factory/runner-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invokeDeps } from "../src/deps.ts";
import worker from "../src/index.ts";
import { MANIFEST, ok, uid, type World, world } from "./helpers.ts";

const CHANGES_ONLY = [
  "runner.heartbeat",
  "job.claim",
  "run.takeSteers",
  "planning.presence",
  "planning.wait",
  "planning.news",
  "run.reportEvents",
];

/** A D1 binding that adds up `rows_written` from every statement and batch (D1's billed unit). */
function meteredEnv(meter: { rows: number }): Env {
  const add = (r: unknown) => {
    const meta = (r as { meta?: { rows_written?: number } } | null)?.meta;
    meter.rows += meta?.rows_written ?? 0;
    return r;
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const run = stmt.run.bind(stmt);
    const all = stmt.all.bind(stmt);
    const bind = stmt.bind.bind(stmt);
    stmt.run = (async () => add(await run())) as typeof stmt.run;
    stmt.all = (async () => add(await all())) as typeof stmt.all;
    stmt.bind = (...values: unknown[]) => wrap(bind(...values));
    return stmt;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const results = await target.batch(stmts);
          for (const r of results) add(r);
          return results;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}

async function auditRows(): Promise<number> {
  return (await env.DB.prepare("SELECT max(rowid) AS n FROM core_audit").first<number>("n")) ?? 0;
}

/**
 * The stored size of the audit rows after `rowid`: as kept now (a runner's input as its digest), and
 * as it was before (the input's body, whose size the digest records).
 */
async function auditBytes(after: number): Promise<{ now: number; before: number }> {
  const row = await env.DB.prepare(
    `SELECT sum(length(id) + length(at) + length(operation) + length(risk) + length(actor_type)
             + length(actor_id) + length(origin) + length(decision) + length(outcome)
             + coalesce(length(reason), 0) + coalesce(length(org_id), 0) + coalesce(length(project_id), 0)
             + coalesce(length(work_item_id), 0) + coalesce(length(policy_sha), 0)
             + length(input) + coalesce(length(result), 0) + coalesce(length(diff), 0)) AS now,
            sum(CASE WHEN json_extract(input, '$.sha256') IS NOT NULL
                     THEN json_extract(input, '$.bytes') - length(input) ELSE 0 END) AS extra
     FROM core_audit WHERE rowid > ?`,
  )
    .bind(after)
    .first<{ now: number | null; extra: number | null }>();
  return { now: row?.now ?? 0, before: (row?.now ?? 0) + (row?.extra ?? 0) };
}

let w: World;
let seq = 0;
let job: { jobId: string; fencingToken: number; workItemId: string };

async function channel(e: Env) {
  return httpControlPlane({
    baseUrl: "https://sf-engine.example",
    runnerId: w.runner.runnerId,
    key: await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1),
    fetch: async (input, init) => worker.fetch(new Request(input, init), e),
    // A second further on each call: heartbeats signed in the same second are refused as replays.
    now: () => new Date(Date.now() + ++tick * 1000),
  });
}
let tick = 0;

/** One cycle of each source, as the clients run it. */
const CYCLES: { name: string; seconds: number; run: (e: Env) => Promise<unknown> }[] = [
  {
    // runner-host: a heartbeat and a claim every 20 s.
    name: "idle runner",
    seconds: 20,
    run: async (e) => {
      const c = await channel(e);
      await c.heartbeat({
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 1, accepting: true },
        activeJobs: [{ jobId: job.jobId, fencingToken: job.fencingToken }],
      });
      await c.claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 1, accepting: true },
      });
    },
  },
  {
    // runner-host: the held steer call, re-armed every 25 s per running job (3 takes per hold:
    // the first read, the read after taking the hub's sequence, the read after the wait).
    name: "running job (steer hold)",
    seconds: 25,
    run: async (e) =>
      (await channel(e)).steers?.(job.jobId, { fencingToken: job.fencingToken, waitMs: 30 }),
  },
  {
    // runner-host: a batch of logs every 3 s while the agent works (50 lines, ~120 bytes each).
    name: "running job (log batch)",
    seconds: 3,
    run: async (e) =>
      (await channel(e)).events(job.jobId, {
        fencingToken: job.fencingToken,
        events: Array.from({ length: 50 }, () => ({
          type: "log" as const,
          stream: "terminal" as const,
          text: "x".repeat(120),
          jobId: job.jobId,
          seq: ++seq,
          at: new Date().toISOString(),
        })),
      }),
  },
  {
    // The app: planning.presence every 20 s while a Planning tab is open.
    name: "open Planning tab",
    seconds: 20,
    run: (e) =>
      invoke(
        invokeDeps(e),
        "planning.presence",
        { workItemId: job.workItemId, open: true },
        { actor: w.human, origin: { surface: "test" } },
      ),
  },
];

async function measure(
  run: (e: Env) => Promise<unknown>,
): Promise<{ rowsWritten: number; auditRows: number; auditBytes: number; bodyBytes: number }> {
  const meter = { rows: 0 };
  const before = await auditRows();
  await run(meteredEnv(meter));
  const bytes = await auditBytes(before);
  return {
    rowsWritten: meter.rows,
    auditRows: (await auditRows()) - before,
    auditBytes: bytes.now,
    bodyBytes: bytes.before,
  };
}

const saved = new Map<string, unknown>();
function changesOnly(on: boolean) {
  for (const name of CHANGES_ONLY) {
    const op = getOperation(name) as { audit?: unknown };
    if (!saved.has(name)) saved.set(name, op.audit);
    op.audit = on ? saved.get(name) : undefined;
  }
}

describe("audit volume of machine-frequency calls (ADR 0590)", () => {
  beforeAll(async () => {
    w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Volume" },
      w.human,
    );
    const c = await channel(env);
    for (let i = 0; i < 100 && !job; i++) {
      const claimed = await c.claim({
        claimId: uid("claim-"),
        manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "steer"] },
        capacity: { max: 4, inUse: 0, accepting: true },
      });
      if (claimed.job) {
        job = {
          jobId: claimed.job.jobId,
          fencingToken: claimed.job.lease.fencingToken,
          workItemId: item.workItemId,
        };
      } else await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job");
    // A person's first arrival is a change; the steady state is what repeats.
    for (const cycle of CYCLES) await cycle.run(env);
  });
  afterAll(() => changesOnly(true));

  it("writes no audit row for a cycle that changed nothing, and fewer rows overall", async () => {
    const report: string[] = [];
    for (const cycle of CYCLES) {
      changesOnly(false);
      const before = await measure(cycle.run);
      changesOnly(true);
      const after = await measure(cycle.run);
      const perDay = 86_400 / cycle.seconds;
      report.push(
        `${cycle.name}: per cycle ${before.rowsWritten} → ${after.rowsWritten} rows written, ` +
          `${before.auditRows} → ${after.auditRows} audit rows; per day ` +
          `${Math.round(before.rowsWritten * perDay)} → ${Math.round(after.rowsWritten * perDay)} rows written, ` +
          `${Math.round(before.auditRows * perDay)} → ${Math.round(after.auditRows * perDay)} audit rows, ` +
          `${Math.round((before.bodyBytes * perDay) / 1e6)} MB → ${Math.round((after.auditBytes * perDay) / 1e6)} MB of audit`,
      );
      expect(after.auditRows).toBe(0);
      expect(before.auditRows).toBeGreaterThan(0);
      expect(after.rowsWritten).toBeLessThan(before.rowsWritten);
    }
    console.log(report.join("\n"));
  });

  it("keeps a runner's input as a digest, never its body", async () => {
    await (await channel(env)).heartbeat({
      manifest: MANIFEST,
      capacity: { max: 2, inUse: 1, accepting: true },
      activeJobs: [{ jobId: "job_gone", fencingToken: 1 }],
    });
    const row = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'runner.heartbeat' AND actor_id = ? ORDER BY rowid DESC LIMIT 1",
    )
      .bind(w.runner.runnerId)
      .first<{ input: string }>();
    const input = JSON.parse(row?.input ?? "null") as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["bytes", "sha256"]);
    expect(row?.input).not.toContain("manifest");
  });
});
