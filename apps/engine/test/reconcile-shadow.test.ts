// The shadow reconciler's pass and pruning (spec 52 PR (c)): off the Workflow's path, it reads the
// items that ended since its cursor and writes one verdict row each; old verdicts go, a bounded batch
// at a time.
import { env } from "cloudflare:workers";
import { SOFTWARE } from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import {
  pruneReconcileShadow,
  SHADOW_CURSOR,
  SHADOW_LAG_MS,
  shadowPass,
  VERDICT_KEEP_MS,
} from "../src/reconcile-shadow.ts";
import {
  all,
  BALANCED,
  build,
  first,
  gateHead,
  gateOpen,
  itemStatus,
  ok,
  runStage,
  triage,
  verifyFail,
  verifyPass,
  world,
} from "./helpers.ts";
import { type Recorded, recordingEnv } from "./query-plans.ts";

const later = () => new Date(Date.now() + SHADOW_LAG_MS + 60_000);

/**
 * An item ended as `status` with the given stage history, written directly. Created in the Backlog,
 * so no Workflow starts and writes stages of its own.
 */
async function ended(w: Awaited<ReturnType<typeof world>>, status: string, stages: string[]) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "backlog", projectId: w.projectId, title: "Shadowed" },
    w.human,
  );
  const id = item.workItemId;
  const t0 = Date.now();
  await env.DB.batch([
    ...stages.map((x, i) => {
      const [stage, st] = x.split(":");
      return env.DB.prepare(
        "INSERT INTO core_stages (id, work_item_id, stage, attempt, status, started_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).bind(`st_${id}_${i}`, id, stage, st, new Date(t0 + i).toISOString());
    }),
    env.DB.prepare(
      "UPDATE core_work_items SET status = ?, size = 'small', spec_required = 0, pulled_at = ?, updated_at = ? WHERE id = ?",
    ).bind(status, new Date(t0).toISOString(), new Date(t0 + 100).toISOString(), id),
  ]);
  return id;
}

const SMALL_DONE = [
  "intake:done",
  "triage:done",
  "spec:skipped",
  "build:done",
  "verify:done",
  "merge:done",
  "done:done",
];

describe("the shadow reconciler", () => {
  it("writes nothing on the Workflow's path; the pass reads ended items after its cursor, one row each", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Shadowed" },
      w.human,
    );
    await ok("workItem.cancel", { workItemId: item.workItemId, reason: "test" }, w.human);
    // No outbox message and no shadow row from the operations themselves.
    expect(await all("SELECT id FROM core_outbox WHERE kind LIKE 'reconcile%'")).toEqual([]);
    expect(await first("SELECT work_item_id FROM core_reconcile_items")).toBeNull();
    // Within the lag the item waits: its write may not be the last one in flight.
    while ((await shadowPass(env, new Date())) > 0);
    const before = await first<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      SHADOW_CURSOR,
    );
    expect(before?.value ?? "").not.toContain(item.workItemId);
    const seen: Recorded[] = [];
    while ((await shadowPass(recordingEnv(env, seen), later())) > 0);
    // The audit table is the hottest write table, with no index to find ends by: never read here.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((r) => /core_audit/.test(r.sql))).toEqual([]);
    const cursor = await first<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      SHADOW_CURSOR,
    );
    expect(cursor?.value).toBeTruthy();
    // A second pass reads nothing new.
    expect(await shadowPass(env, later())).toBe(0);
  });

  it("pages by (updated_at, id): items that ended at the same instant are all read", async () => {
    const w = await world();
    while ((await shadowPass(env, later())) > 0);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await ended(w, "done", SMALL_DONE));
    const same = new Date(Date.now() + 5).toISOString();
    for (const id of ids)
      await env.DB.prepare("UPDATE core_work_items SET updated_at = ? WHERE id = ?")
        .bind(same, id)
        .run();
    let read = 0;
    for (let n = await shadowPass(env, later()); n > 0; n = await shadowPass(env, later()))
      read += n;
    expect(read).toBe(3);
    const rows = await all<{ work_item_id: string }>(
      `SELECT work_item_id FROM core_reconcile_items WHERE work_item_id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );
    expect(rows).toHaveLength(3);
  });

  it("names a head the merge queue moved, apart from other divergences (spec 53)", async () => {
    const w = await world();
    const moved = await ended(w, "done", SMALL_DONE);
    const still = await ended(w, "done", SMALL_DONE);
    await env.DB.prepare(
      "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES ('rp_carried', ?, 'b2', 'pass', ?, ?)",
    )
      .bind(moved, JSON.stringify({ carriedFrom: "a1" }), new Date().toISOString())
      .run();
    // The other has a packet too, so the two differ only by the named difference.
    await env.DB.prepare(
      "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES ('rp_still', ?, 'b2', 'pass', '{}', ?)",
    )
      .bind(still, new Date().toISOString())
      .run();
    while ((await shadowPass(env, later())) > 0);
    const report = async (id: string) =>
      ok<{ report: { known: { reason: string }[]; divergences: number } }>(
        "reconcile.report",
        { workItemId: id },
        w.human,
      );
    const a = await report(moved);
    const b = await report(still);
    expect(a.report.known.map((k) => k.reason)).toEqual(["queue-head-moved"]);
    expect(b.report.known).toEqual([]);
    expect(a.report.divergences).toBe(b.report.divergences + 1);
  });

  it("deletes verdicts past 90 days, keeping newer ones", async () => {
    const now = new Date("2027-03-01T00:00:00.000Z");
    const old = new Date(now.getTime() - VERDICT_KEEP_MS - 1).toISOString();
    const fresh = new Date(now.getTime() - 1_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_reconcile_items (work_item_id, org_id, ended, transitions, divergences, report, finished_at) VALUES ('wi_old', 'org_p', 'done', 1, 6, '{}', ?), ('wi_new', 'org_p', 'done', 1, 6, '{}', ?)",
    )
      .bind(old, fresh)
      .run();
    await pruneReconcileShadow(env, now);
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_old'"),
    ).toBeNull();
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_new'"),
    ).not.toBeNull();
  });
});

describe("the shadow reconciler on an org workflow (spec 52 PR (d))", () => {
  it("compares an item with the org workflow it pinned, overrides resolved", async () => {
    const w = await world({ version: 1, autonomyPolicy: "balanced", workflow: "wf_ship" });
    // The org's Ship wants a spec from small; the project's own default is medium.
    const ship = {
      ...SOFTWARE,
      id: "wf_ship",
      name: "Ship",
      stages: SOFTWARE.stages.map((s) =>
        s.id === "spec" ? { ...s, settings: { requiredFrom: "small" } } : s,
      ),
    };
    await ok("workflow.save", { orgId: w.orgId, baseVersion: 0, workflow: ship }, w.human);
    while ((await shadowPass(env, later())) > 0);
    const id = await ended(w, "done", SMALL_DONE);
    await env.DB.prepare(
      "UPDATE core_work_items SET org_config_version = 1, workflow = ? WHERE id = ?",
    )
      .bind("wf_ship", id)
      .run();
    while ((await shadowPass(env, later())) > 0);
    const row = await first<{ divergences: number; report: string }>(
      "SELECT divergences, report FROM core_reconcile_items WHERE work_item_id = ?",
      id,
    );
    // Before (d), an item on an org workflow had no verdict at all. Now it is compared with the
    // org's definition: a small item that skipped the spec diverges from a workflow that needs one.
    expect(row).not.toBeNull();
    const report = JSON.parse(row?.report ?? "{}") as {
      transitions: { observed: string; predicted: string; agrees: boolean }[];
    };
    expect(report.transitions).toContainEqual({
      observed: "skip spec",
      predicted: "enter spec",
      agrees: false,
    });
  });

  it("an item it can't compare still writes its row, with why: the streak breaks, it isn't skipped", async () => {
    const w = await world({ version: 1, autonomyPolicy: "balanced", workflow: "wf_ship" });
    await ok(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 0, workflow: { ...SOFTWARE, id: "wf_ship", name: "Ship" } },
      w.human,
    );
    while ((await shadowPass(env, later())) > 0);
    const id = await ended(w, "done", SMALL_DONE);
    await env.DB.prepare("UPDATE core_work_items SET org_config_version = 7 WHERE id = ?")
      .bind(id)
      .run();
    while ((await shadowPass(env, later())) > 0);
    const row = await first<{ divergences: number; report: string }>(
      "SELECT divergences, report FROM core_reconcile_items WHERE work_item_id = ?",
      id,
    );
    expect(row?.divergences).toBe(1);
    expect(JSON.parse(row?.report ?? "{}").uncompared).toEqual([
      "the org workflow the item pinned can't be resolved",
    ]);
  });
});

// ---- Against the real Workflow: items run end to end, then the shadow pass compares everything ----

describe("the complete comparison agrees with the real Workflow", () => {
  const report = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    ok<{
      report: {
        transitions: { observed: string; predicted: string; agrees: boolean }[];
        uncompared: string[];
        divergences: number;
      } | null;
    }>("reconcile.report", { workItemId: id }, w.human);
  const disagreements = (r: Awaited<ReturnType<typeof report>>) =>
    (r.report?.transitions ?? [])
      .filter((t) => !t.agrees)
      .map((t) => `${t.observed} ≠ ${t.predicted}`);

  async function merged(w: Awaited<ReturnType<typeof world>>, id: string) {
    await gateOpen(id, "merge");
    await ok(
      "review.merge",
      { workItemId: id, openedFullDiff: false, headSha: await gateHead(id) },
      w.human,
    );
    await itemStatus(id, "done");
  }

  it("a small change, a failed verify sent back to build, and a slot step's send-back: no divergence", async () => {
    const w = await world({
      ...BALANCED,
      agents: [{ name: "Security", role: "review", tier: "light", instructions: "Auth." }],
      workflows: [
        {
          name: "Ship",
          slots: {
            beforeVerify: [
              { id: "security", kind: "work", name: "Security review", agent: "Security" },
            ],
          },
        },
      ],
      workflow: "Ship",
    });
    const create = (title: string) =>
      ok<{ workItemId: string }>(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title },
        w.human,
      );
    // One straight through.
    const plain = await create("Straight through");
    await runStage(w, plain.workItemId, "triage", () => triage("small"));
    await runStage(w, plain.workItemId, "build", () => build());
    await runStage(w, plain.workItemId, "verify", () => ({
      result: { verdict: "pass", summary: "Fine" },
    }));
    await runStage(w, plain.workItemId, "verify", () => verifyPass);
    await merged(w, plain.workItemId);

    // One the security step sends back once.
    const back = await create("Sent back");
    await runStage(w, back.workItemId, "triage", () => triage("small"));
    await runStage(w, back.workItemId, "build", () => build());
    await runStage(w, back.workItemId, "verify", () => ({
      result: { verdict: "sendBack", summary: "Token in a log", notes: "Drop it" },
    }));
    await runStage(w, back.workItemId, "build", () => build());
    await runStage(w, back.workItemId, "verify", () => ({
      result: { verdict: "pass", summary: "Clean" },
    }));
    await runStage(w, back.workItemId, "verify", () => verifyPass);
    await merged(w, back.workItemId);

    while ((await shadowPass(env, later())) > 0);
    for (const id of [plain.workItemId, back.workItemId]) {
      const r = await report(w, id);
      expect(r.report, id).not.toBeNull();
      expect(r.report?.uncompared).toEqual([]);
      expect(disagreements(r), id).toEqual([]);
      expect(r.report?.divergences).toBe(0);
    }
    const seen = (await report(w, back.workItemId)).report?.transitions.map((t) => t.observed);
    expect(seen).toEqual(
      expect.arrayContaining([
        "job triage triage",
        "job build build",
        "job security check",
        "sendBack security → build",
        "job verify verify",
        "gate merge gate",
        "merge gate decided by a person",
        "operation merge",
        "end done",
      ]),
    );
  });

  it("a verify that fails goes back to build; a build failing past its retry limit fails the item: no divergence", async () => {
    const w = await world({ ...BALANCED, retryLimit: 1 });
    const create = (title: string) =>
      ok<{ workItemId: string }>(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title },
        w.human,
      );
    const again = await create("Verify fails once");
    await runStage(w, again.workItemId, "triage", () => triage("small"));
    await runStage(w, again.workItemId, "build", () => build());
    await runStage(w, again.workItemId, "verify", () => verifyFail);
    await runStage(w, again.workItemId, "build", () => build(["src/theme.ts", "src/fix.ts"]));
    await runStage(w, again.workItemId, "verify", () => verifyPass);
    await merged(w, again.workItemId);

    const broken = await create("Never builds");
    await runStage(w, broken.workItemId, "triage", () => triage("small"));
    await runStage(w, broken.workItemId, "build", () => ({ outcome: "failed" as const }));
    await runStage(w, broken.workItemId, "build", () => ({ outcome: "failed" as const }));
    await itemStatus(broken.workItemId, "failed");

    while ((await shadowPass(env, later())) > 0);
    const a = await report(w, again.workItemId);
    expect(disagreements(a)).toEqual([]);
    expect(a.report?.transitions.map((t) => t.observed)).toContain("sendBack verify → build");
    const b = await report(w, broken.workItemId);
    expect(disagreements(b)).toEqual([]);
    expect(b.report?.transitions.at(-1)?.observed).toBe("end failed");
  });
});
