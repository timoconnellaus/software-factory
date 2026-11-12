// Spec 52 PR (c1), second review: the reconciler counts failed attempts exactly as today's Workflow
// does. Each case runs the real Workflow, then drives `reconcile()` through the same outcomes, and
// compares how many builds ran and how the item ended.
import { parseProjectPolicy } from "@software-factory/core";
import {
  compileProjectWorkflow,
  type ItemSnapshot,
  reconcile,
  type StageEntry,
  type StepAttempt,
} from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
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

type Verdict = "pass" | "sendBack";

/** What each attempt answers, in order: checks pass or fail, an agent check's verdict, the merge gate. */
interface Outcomes {
  checks: ("pass" | "fail")[];
  agentCheck?: Verdict[];
  merge: ("approve" | "sendBack")[];
}

/** Drives `reconcile()` to an end with the outcomes; returns the builds it ran and how it ended. */
function reconciled(policyJson: object, outcomes: Outcomes) {
  const parsed = parseProjectPolicy(JSON.stringify(policyJson));
  if (!parsed.ok) throw new Error(parsed.error);
  const policy = parsed.policy;
  const checks = [...outcomes.checks];
  const agent = [...(outcomes.agentCheck ?? [])];
  const merge = [...outcomes.merge];
  let head = 0;
  let snap: ItemSnapshot = {
    item: {
      kind: "change",
      size: "small",
      domains: [],
      hasRepository: true,
      released: true,
      retryLimit: policy.retryLimit,
    },
    definition: compileProjectWorkflow(policy, policy.workflow),
    stages: [],
    steps: [],
    observations: {},
  };
  let builds = 0;
  const sha = () => head.toString(16).padStart(40, "0");
  const end = (status: StageEntry["status"], note?: string, free?: boolean) => {
    const stages = [...snap.stages];
    const last = stages.at(-1) as StageEntry;
    stages[stages.length - 1] = {
      ...last,
      status,
      ...(note ? { note } : {}),
      ...(free ? { free } : {}),
    };
    snap = { ...snap, stages };
  };
  for (let i = 0; i < 200; i++) {
    const a = reconcile(snap);
    const round = snap.stages.at(-1)?.round ?? 1;
    const step = (s: Omit<StepAttempt, "attempt">) => {
      snap = { ...snap, steps: [...snap.steps, { ...s, attempt: 1 }] };
    };
    switch (a.kind) {
      case "enter":
        snap = {
          ...snap,
          stages: [
            ...snap.stages,
            { stageId: a.stageId, round: a.round, typeVersion: 1, status: "active" },
          ],
          observations: { headSha: sha() },
        };
        break;
      case "skip":
        snap = {
          ...snap,
          stages: [
            ...snap.stages,
            { stageId: a.stageId, round: 1, typeVersion: 1, status: "skipped" },
          ],
        };
        break;
      case "job": {
        if (a.stepId === "build") {
          builds++;
          head++;
        }
        const failed = a.stepId === "verify" && checks.shift() === "fail";
        const verdict = a.stepId === "check" ? (agent.shift() ?? "pass") : undefined;
        step({
          stageId: a.stageId,
          round,
          stepId: a.stepId,
          status: "ok",
          ...(failed ? { output: { failures: ["tests"] } } : {}),
          ...(verdict ? { output: { verdict, note: "no" } } : {}),
        });
        snap = { ...snap, observations: { headSha: sha(), ci: failed ? "fail" : "pass" } };
        break;
      }
      case "gate": {
        const d = a.gateKind === "merge" ? (merge.shift() ?? "approve") : "approve";
        step({
          stageId: a.stageId,
          round,
          stepId: a.stepId,
          status: d === "approve" ? "approved" : "sent_back",
          headSha: sha(),
        });
        break;
      }
      case "operation":
        step({ stageId: a.stageId, round, stepId: a.stepId, status: "ok" });
        snap = { ...snap, observations: { ...snap.observations, merged: true } };
        break;
      case "wait":
        if (a.why === "queue") {
          snap = { ...snap, observations: { ...snap.observations, queueTurn: true } };
          break;
        }
        throw new Error(`unexpected wait ${a.why}`);
      case "complete":
        end("done");
        break;
      case "sendBack":
        end("sent_back", `to:${a.to}\n${a.note}`, a.free);
        break;
      case "done":
        return { builds, end: "done" };
      case "fail":
        return { builds, end: "failed" };
      default:
        throw new Error(`unexpected ${a.kind}`);
    }
  }
  throw new Error("no end");
}

/** Runs the real Workflow with the same outcomes; returns its builds and how it ended. */
async function today(policyJson: object, outcomes: Outcomes, agentStep: boolean) {
  const w = await world(policyJson);
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title: "Count the retries" },
    w.human,
  );
  const id = item.workItemId;
  const checks = [...outcomes.checks];
  const agent = [...(outcomes.agentCheck ?? [])];
  const merge = [...outcomes.merge];
  await runStage(w, id, "triage", () => triage("small"));
  for (;;) {
    await runStage(w, id, "build", () => build());
    if (agentStep) {
      const verdict = agent.shift() ?? "pass";
      await runStage(w, id, "verify", () => ({
        result: { verdict, summary: verdict, ...(verdict === "sendBack" ? { notes: "no" } : {}) },
      }));
      if (verdict === "sendBack") {
        if (await ended(id)) break;
        continue;
      }
    }
    const pass = checks.shift() !== "fail";
    await runStage(w, id, "verify", () => (pass ? verifyPass : verifyFail));
    if (!pass) {
      if (await ended(id)) break;
      continue;
    }
    await gateOpen(id, "merge");
    if ((merge.shift() ?? "approve") === "approve") {
      await ok(
        "review.merge",
        { workItemId: id, openedFullDiff: true, headSha: await gateHead(id) },
        w.human,
      );
      await itemStatus(id, "done");
      break;
    }
    const sent = await ok<{ incidentId: string | null }>(
      "review.sendBack",
      { workItemId: id, note: "again", openedFullDiff: true },
      w.human,
    );
    // The send-back opens an incident: cancel its item so this runner sees only this item's jobs.
    if (sent.incidentId) {
      const inc = await first<{ fix_work_item_id: string }>(
        "SELECT fix_work_item_id FROM core_incidents WHERE id = ?",
        sent.incidentId,
      );
      await ok(
        "workItem.cancel",
        { workItemId: inc?.fix_work_item_id, reason: "not here" },
        w.human,
      );
    }
  }
  const builds = await all(
    "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
    id,
  );
  const status = await first<{ status: string }>(
    "SELECT status FROM core_work_items WHERE id = ?",
    id,
  );
  return { builds: builds.length, end: status?.status };
}

/** After a failed attempt: the item failed, or a new build is queued. */
async function ended(id: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const s = await first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ?",
      id,
    );
    if (s?.status === "failed") return true;
    const queued = await first(
      "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build' AND status = 'queued'",
      id,
    );
    if (queued) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("neither failed nor rebuilt");
}

const AGENTS = {
  agents: [{ name: "Security", role: "review", tier: "light", instructions: "" }],
  workflows: [
    {
      name: "Gated",
      slots: { beforeVerify: [{ id: "sec", kind: "work", name: "Security", agent: "Security" }] },
      core: {},
    },
  ],
  workflow: "Gated",
};

describe("the reconciler counts failed attempts as today's Workflow does", () => {
  it("checks that keep failing: the same builds, then failed", async () => {
    const policy = { ...BALANCED, retryLimit: 2 };
    const outcomes: Outcomes = { checks: ["fail", "fail", "fail", "fail"], merge: [] };
    const real = await today(policy, outcomes, false);
    expect(real).toEqual({ builds: 3, end: "failed" });
    expect(reconciled(policy, outcomes)).toEqual(real);
  }, 60_000);

  it("a person's merge send-backs don't count: more of them than the retry limit still merges", async () => {
    const policy = { ...BALANCED, retryLimit: 1 };
    const outcomes: Outcomes = { checks: [], merge: ["sendBack", "sendBack", "approve"] };
    const real = await today(policy, outcomes, false);
    expect(real).toEqual({ builds: 3, end: "done" });
    expect(reconciled(policy, outcomes)).toEqual(real);
  }, 60_000);

  it("an agent check that keeps sending back: bounded, the same builds, then failed", async () => {
    const policy = { ...BALANCED, retryLimit: 1, ...AGENTS };
    const outcomes: Outcomes = {
      checks: [],
      agentCheck: ["sendBack", "sendBack", "sendBack", "sendBack"],
      merge: [],
    };
    const real = await today(policy, outcomes, true);
    expect(real).toEqual({ builds: 2, end: "failed" });
    expect(reconciled(policy, outcomes)).toEqual(real);
  }, 60_000);
});
