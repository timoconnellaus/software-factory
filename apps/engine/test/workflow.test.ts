import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SHADOW_NOT_COMPARED, type ShadowVerdict } from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import { SHADOW_LAG_MS, shadowPass } from "../src/reconcile-shadow.ts";
import {
  definitionFor,
  expectPhasesAsDefined,
  expectSendBacksAsDefined,
  expectStagesAsDefined,
} from "./definition.ts";
import {
  all,
  BALANCED,
  build,
  first,
  gateHead,
  gateOpen,
  github,
  itemStatus,
  MANIFEST,
  ok,
  runStage,
  triage,
  uid,
  verifyFail,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

async function create(w: Awaited<ReturnType<typeof world>>, title = "Add dark mode") {
  return ok<{ workItemId: string; branch: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
}

/**
 * The shadow reconciler's verdict on an ended item (spec 52 PR (c)), once the cron's shadow pass has
 * read it: the transitions it compared, and what it couldn't (each a divergence).
 */
async function shadowVerdictOf(workItemId: string) {
  // The Workflow wrote nothing for the shadow: no verdict until the pass runs.
  expect(
    await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = ?", workItemId),
  ).toBeNull();
  // Past the pass's lag, so the item's last write is old enough to read.
  const later = new Date(Date.now() + SHADOW_LAG_MS + 60_000);
  while ((await shadowPass(env, later)) > 0);
  const row = await first<{ report: string; divergences: number }>(
    "SELECT report, divergences FROM core_reconcile_items WHERE work_item_id = ?",
    workItemId,
  );
  if (!row) throw new Error("no shadow verdict");
  const verdict = JSON.parse(row.report) as ShadowVerdict;
  expect(verdict.uncompared).toEqual([...SHADOW_NOT_COMPARED]);
  expect(row.divergences).toBe(
    verdict.transitions.filter((t) => !t.agrees).length +
      SHADOW_NOT_COMPARED.length +
      verdict.known.length,
  );
  return verdict.transitions.map((t) => (t.agrees ? t.observed : `${t.observed} ≠ ${t.predicted}`));
}

describe("the work-item Workflow", () => {
  it("runs a small item end to end: triage skips the spec, build, verify, merge gate, merged", async () => {
    const w = await world();
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const built = await runStage(w, item.workItemId, "build", () => build());
    expect(built.branch).toBe(`${item.branch}-run-2`);
    await runStage(w, item.workItemId, "verify", () => verifyPass);

    await gateOpen(item.workItemId, "merge");
    const packet = await first<{ verdict: string }>(
      "SELECT verdict FROM core_review_packets WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(packet?.verdict).toBe("pass");
    const decided = await ok<{ alreadyDecided: boolean }>(
      "review.merge",
      {
        workItemId: item.workItemId,
        openedFullDiff: false,
        headSha: await gateHead(item.workItemId),
      },
      w.human,
    );
    expect(decided.alreadyDecided).toBe(false);
    await itemStatus(item.workItemId, "done");

    const state = await github.state(w.repo);
    expect(state.pulls[0]?.state).toBe("merged");
    const stages = await all<{ stage: string; status: string; reason: string | null }>(
      "SELECT stage, status, reason FROM core_stages WHERE work_item_id = ? ORDER BY started_at, rowid",
      item.workItemId,
    );
    expect(stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      "intake:done",
      "triage:done",
      "spec:skipped",
      "build:done",
      "verify:done",
      "merge:done",
      "done:done",
    ]);
    expect(stages.find((s) => s.stage === "spec")?.reason).toMatch(/below the spec threshold/);
    // The reconciler in shadow predicted everything the Workflow did: each stage, job, gate and who
    // decided it, the merge and the end (spec 52 PR (c), complete).
    expect(await shadowVerdictOf(item.workItemId)).toEqual([
      "enter triage",
      "job triage triage",
      "complete triage",
      "skip spec",
      "enter build",
      "job build build",
      "complete build",
      "enter verify",
      "job verify verify",
      "complete verify",
      "enter merge",
      "gate merge gate",
      "merge gate decided by a person",
      "operation merge",
      "complete merge",
      "end done",
    ]);
    // The compiled Software definition passes and skips the same stages (spec 52 PR (a)).
    const { def } = definitionFor(BALANCED, "change");
    await expectStagesAsDefined(item.workItemId, def, "small");

    // The journal tells the whole story, including the gate decision and how long it was open.
    const trail = await all<{ operation: string; actor_type: string; outcome: string }>(
      "SELECT operation, actor_type, outcome FROM core_audit WHERE work_item_id = ? ORDER BY at, rowid",
      item.workItemId,
    );
    const ops = trail.map((t) => `${t.operation}:${t.outcome}`);
    expect(ops).toContain("workItem.triage:ok");
    expect(ops).toContain("pr.merge:review");
    expect(ops).toContain("review.merge:ok");
    expect(ops.at(-1)).toBe("workItem.finish:ok");
    const gate = await first<{ decided_by: string; gate_open_ms: number }>(
      "SELECT decided_by, gate_open_ms FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      item.workItemId,
    );
    expect(gate?.decided_by).toBe(w.userId);
    expect(gate?.gate_open_ms).toBeGreaterThanOrEqual(0);
  });

  it("v4: stops at the spec gate for medium work even when the foreman asks to skip it; request changes loops back, approve commits the spec", async () => {
    // V1's spec rounds, as a v4 instance started before v5's planning sessions runs them (ADR 0053).
    await using introspector = await introspectWorkflow(env.WORK_ITEM_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "meta: version" }, 4);
    });
    const w = await world();
    const item = await create(w, "Rework settings");
    await runStage(w, item.workItemId, "triage", () => triage("medium", { specRequested: "skip" }));
    const spec = {
      specMd: "# Rework settings\n\n## Goal\n...",
      acceptanceCriteria: ["Settings are grouped"],
      assumptions: [],
      questions: [],
    };
    await runStage(w, item.workItemId, "spec", () => ({ result: spec }));
    await gateOpen(item.workItemId, "spec");
    await ok(
      "spec.requestChanges",
      { workItemId: item.workItemId, note: "Split into two pages" },
      w.human,
    );

    const second = await runStage(w, item.workItemId, "spec", (job) => {
      expect(job.context.note).toBe("Split into two pages");
      return { result: { ...spec, specMd: "# v2" } };
    });
    expect(second.stage).toBe("spec");
    await gateOpen(item.workItemId, "spec");
    await ok(
      "spec.requestChanges",
      { workItemId: item.workItemId, note: "And a search box" },
      w.human,
    );
    await runStage(w, item.workItemId, "spec", () => ({ result: { ...spec, specMd: "# v3" } }));
    await gateOpen(item.workItemId, "spec");
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);

    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.prompt).toMatch(/docs\/specs\/wi-1-rework-settings\.md/);
      return build();
    });
    const committed = await first<{ path: string; status: string }>(
      "SELECT path, status FROM core_specs WHERE work_item_id = ? AND status = 'approved'",
      item.workItemId,
    );
    expect(committed?.path).toBe("docs/specs/wi-1-rework-settings.md");
    const state = await github.state(w.repo);
    expect(Object.keys(state.files[item.branch] ?? {})).toContain(
      "docs/specs/wi-1-rework-settings.md",
    );
    const versions = await all(
      "SELECT version FROM core_specs WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(versions.length).toBe(4); // triage draft + three spec rounds
  });

  it("v2: a v2 instance in its spec stage at deploy time finishes on the v2 path: blocking questions, then the answers in the next spec run (spec 20, criterion 12)", async () => {
    await using introspector = await introspectWorkflow(env.WORK_ITEM_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "meta: version" }, 2);
    });
    const w = await world();
    const item = await create(w, "Pick a theme store");
    await runStage(w, item.workItemId, "triage", () => triage("large"));
    await runStage(w, item.workItemId, "spec", () => ({
      result: {
        specMd: "# Theme",
        acceptanceCriteria: ["Theme persists"],
        questions: [
          {
            prompt: "Where to store it?",
            defaultAnswer: "localStorage",
            recommendation: "localStorage",
          },
        ],
      },
    }));
    const q = await waitFor("an open question", () =>
      first<{ id: string }>(
        "SELECT id FROM core_questions WHERE work_item_id = ? AND status = 'open'",
        item.workItemId,
      ),
    );
    await itemStatus(item.workItemId, "waiting");
    await ok("question.answer", { questionId: q.id, answer: "a cookie" }, w.human);
    await runStage(w, item.workItemId, "spec", (job) => {
      expect(job.context.answers).toEqual([{ prompt: "Where to store it?", answer: "a cookie" }]);
      return {
        result: { specMd: "# Theme v2", acceptanceCriteria: ["Theme persists in a cookie"] },
      };
    });
    await gateOpen(item.workItemId, "spec");
  });

  it("sends a failed verify back to build with the failures, then a sent-back PR loops again, opening an incident", async () => {
    const w = await world({ ...BALANCED, retryLimit: 2 });
    const item = await create(w, "Fix the flaky test");
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    await runStage(w, item.workItemId, "verify", () => verifyFail);
    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.prompt).toMatch(/unmet: The page has a dark mode toggle/);
      return build();
    });
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    await gateOpen(item.workItemId, "merge");
    const sent = await ok<{ incidentId: string | null }>(
      "review.sendBack",
      { workItemId: item.workItemId, note: "Needs a regression test", openedFullDiff: true },
      w.human,
    );
    expect(sent.incidentId).toMatch(/^inc_/);
    // The incident is its own work item; cancel it so this runner only sees this item's jobs.
    const incident = await first<{ fix_work_item_id: string }>(
      "SELECT fix_work_item_id FROM core_incidents WHERE id = ?",
      sent.incidentId,
    );
    await ok(
      "workItem.cancel",
      { workItemId: incident?.fix_work_item_id, reason: "not in this test" },
      w.human,
    );
    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.prompt).toMatch(/Needs a regression test/);
      return build(["test/flaky.test.ts"]);
    });
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    await gateOpen(item.workItemId, "merge");
    await ok(
      "review.merge",
      {
        workItemId: item.workItemId,
        openedFullDiff: true,
        headSha: await gateHead(item.workItemId),
      },
      w.human,
    );
    await itemStatus(item.workItemId, "done");
    const stages = await all<{ stage: string; status: string }>(
      "SELECT stage, status FROM core_stages WHERE work_item_id = ? AND stage IN ('build', 'verify', 'merge') ORDER BY started_at, rowid",
      item.workItemId,
    );
    // The shadow predicts both send-backs and where they went: the failed verify and the person's
    // send-back at the merge gate both go back to build, and nothing diverges.
    const shadow = await shadowVerdictOf(item.workItemId);
    expect(shadow.filter((t) => t === "sendBack verify → build")).toHaveLength(1);
    expect(shadow.filter((t) => t === "sendBack merge → build")).toHaveLength(1);
    expect(shadow.filter((t) => t.includes("≠"))).toEqual([]);
    // Both send-backs went where the compiled definition sends them (spec 52 PR (a)).
    const { def } = definitionFor({ ...BALANCED, retryLimit: 2 }, "change");
    await expectStagesAsDefined(item.workItemId, def, "small");
    expect(await expectSendBacksAsDefined(item.workItemId, def)).toBe(2);
    // Both loops ran inside the one instance: verify → build on a failed check, merge → build on a send-back.
    expect(stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      "build:done",
      "verify:failed",
      "build:done",
      "verify:done",
      "merge:sent_back",
      "build:done",
      "verify:done",
      "merge:done",
    ]);
  });

  it("runs an incident's fix as the Incident definition says: opened released, nothing shaped, every stage in delivery (spec 52 PR (a))", async () => {
    const w = await world();
    const item = await create(w, "Something broke");
    const opened = await ok<{ fixWorkItemId: string | null }>(
      "incident.open",
      { workItemId: item.workItemId, kind: "manual", reason: "the run looped" },
      w.human,
    );
    const fix = opened.fixWorkItemId;
    if (!fix) throw new Error("no fix item");
    // Only the fix's jobs for this runner.
    await ok(
      "workItem.cancel",
      { workItemId: item.workItemId, reason: "not in this test" },
      w.human,
    );
    const kind = await first<{ kind: string }>(
      "SELECT kind FROM core_work_items WHERE id = ?",
      fix,
    );
    expect(kind?.kind).toBe("incident");
    await runStage(w, fix, "triage", () => triage("small"));
    await runStage(w, fix, "build", () => build([".factory/checks/loop.md"]));
    await runStage(w, fix, "verify", () => verifyPass);
    await gateOpen(fix, "merge");
    await ok(
      "review.merge",
      { workItemId: fix, openedFullDiff: true, headSha: await gateHead(fix) },
      w.human,
    );
    await itemStatus(fix, "done");
    const { def } = definitionFor(BALANCED, "incident");
    await expectStagesAsDefined(fix, def, "small");
    await expectPhasesAsDefined(fix, def, "small");
  });

  it("flags a diff that touches .factory/ as self-modify at the merge gate", async () => {
    const w = await world();
    const item = await create(w, "Tighten the policy");
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build([".factory/policy.json"]));
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    await gateOpen(item.workItemId, "merge");
    const gate = await first<{ risk: string }>(
      "SELECT risk FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      item.workItemId,
    );
    expect(gate?.risk).toBe("self-modify");
  });

  it("pauses a project's items under its kill switch and no others, and resumes them when it's turned off", async () => {
    const w = await world();
    const other = await world();
    const item = await create(w, "Killed thing");
    const free = await create(other, "Free thing");
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await waitFor("a queued build", () =>
      first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build' AND status = 'queued'",
        item.workItemId,
      ),
    );
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: true }, w.human);
    await itemStatus(item.workItemId, "paused");
    // The runner gets nothing for the killed project, but the other project's work still runs.
    const nothing = await ok<{ job: unknown }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 4, inUse: 0, accepting: true },
      },
      w.runnerActor,
    );
    expect(nothing.job).toBeNull();
    await runStage(other, free.workItemId, "triage", () => triage("small"));

    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: false }, w.human);
    await itemStatus(item.workItemId, "running");
    await runStage(w, item.workItemId, "build", () => build());
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    await gateOpen(item.workItemId, "merge");
  });

  it("cancels: the Workflow stops and the item is cancelled", async () => {
    const w = await world();
    const item = await create(w, "Never mind");
    await waitFor("a queued triage", () =>
      first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'triage' AND status = 'queued'",
        item.workItemId,
      ),
    );
    await ok(
      "workItem.cancel",
      { workItemId: item.workItemId, reason: "changed my mind" },
      w.human,
    );
    await itemStatus(item.workItemId, "cancelled");
    const job = await first<{ status: string }>(
      "SELECT status FROM core_jobs WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(job?.status).toBe("cancelled");
  });
});
