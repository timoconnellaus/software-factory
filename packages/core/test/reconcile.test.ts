// The reconciler (spec 52 PR (c), ADR 0511): `reconcile()` is pure, so it is tested by driving a
// simulated item through it. The simulator plays the executor: it applies each action to the
// snapshot and scripts what the outside world answers (a job's result, a person's decision, CI).
import { describe, expect, it } from "vitest";
import { parseProjectPolicy } from "../src/index.ts";
import {
  ATTACHED_PR,
  actionKey,
  compileProjectWorkflow,
  type ItemSnapshot,
  type ReconcileAction,
  reconcile,
  SOFTWARE,
  type StageEntry,
  type StepAttempt,
  type WorkflowDefinition,
} from "../src/stages/index.ts";

type Outcome =
  | StepAttempt["status"]
  | { status: StepAttempt["status"]; output: StepAttempt["output"] };

interface Script {
  /** Results for each step id, consumed in order; a missing one is `ok` (a job) or `approved` (a gate). */
  steps?: Record<string, Outcome[]>;
  /** CI on the head, read after each verify run, consumed in order; default `pass`. */
  ci?: ("pass" | "fail" | "pending" | "missing")[];
  released?: boolean;
}

function snapshot(def: WorkflowDefinition, item: Partial<ItemSnapshot["item"]> = {}): ItemSnapshot {
  return {
    item: {
      kind: "change",
      size: "small",
      domains: [],
      hasRepository: true,
      released: true,
      retryLimit: 2,
      ...item,
    },
    definition: def,
    stages: [],
    steps: [],
    observations: {},
  };
}

const describeAction = (a: ReconcileAction): string => {
  switch (a.kind) {
    case "enter":
      return `enter ${a.stageId}#${a.round}`;
    case "skip":
      return `skip ${a.stageId}`;
    case "job":
      return `job ${a.stageId}.${a.stepId}`;
    case "gate":
      return `gate ${a.stageId}.${a.stepId} (${a.gateKind})`;
    case "operation":
      return `op ${a.operation}`;
    case "wait":
      return `wait ${a.why}`;
    case "complete":
      return `complete ${a.stageId}`;
    case "sendBack":
      return `sendBack ${a.stageId} → ${a.to}`;
    case "done":
      return "done";
    case "fail":
      return `fail ${a.stageId}`;
    case "reject":
      return `reject ${a.stageId}`;
  }
};

/** Runs the item to an end (or a wait the script doesn't answer) and returns every action taken. */
function run(start: ItemSnapshot, script: Script = {}, limit = 80): string[] {
  let snap: ItemSnapshot = {
    ...start,
    item: { ...start.item, released: script.released ?? start.item.released },
  };
  const queues = Object.fromEntries(
    Object.entries(script.steps ?? {}).map(([k, v]) => [k, [...v]]),
  ) as Record<string, Outcome[]>;
  const ci = [...(script.ci ?? [])];
  const out: string[] = [];
  const setEntry = (status: StageEntry["status"], note?: string) => {
    const stages = [...snap.stages];
    const last = stages.at(-1) as StageEntry;
    stages[stages.length - 1] = { ...last, status, ...(note !== undefined ? { note } : {}) };
    snap = { ...snap, stages };
  };
  const settle = (key: string, dflt: StepAttempt["status"]) => {
    const steps = [...snap.steps];
    const last = steps.at(-1) as StepAttempt;
    const next = queues[key]?.shift() ?? dflt;
    steps[steps.length - 1] =
      typeof next === "string"
        ? { ...last, status: next }
        : { ...last, status: next.status, output: next.output };
    snap = { ...snap, steps };
  };
  for (let i = 0; i < limit; i++) {
    const a = reconcile(snap);
    out.push(describeAction(a));
    const entry = snap.stages.at(-1);
    switch (a.kind) {
      case "enter":
        snap = {
          ...snap,
          stages: [
            ...snap.stages,
            { stageId: a.stageId, round: a.round, typeVersion: 1, status: "active" },
          ],
          observations: {},
        };
        break;
      case "skip":
        snap = {
          ...snap,
          stages: [
            ...snap.stages,
            { stageId: a.stageId, round: 1, typeVersion: 1, status: "skipped", note: a.reason },
          ],
        };
        break;
      case "job":
      case "gate":
      case "operation": {
        const round = entry?.round ?? 1;
        snap = {
          ...snap,
          steps: [
            ...snap.steps,
            { stageId: a.stageId, round, stepId: a.stepId, attempt: 1, status: "running" },
          ],
        };
        if (a.kind === "operation") {
          snap = { ...snap, observations: { ...snap.observations, merged: true } };
          settle(`${a.stageId}.${a.stepId}`, "ok");
        } else settle(`${a.stageId}.${a.stepId}`, a.kind === "gate" ? "approved" : "ok");
        if (a.kind === "job" && a.stepId === "verify")
          snap = { ...snap, observations: { ...snap.observations, ci: ci.shift() ?? "pass" } };
        break;
      }
      case "wait":
        if (a.why === "release" && !snap.item.released) return out;
        if (a.why === "queue") {
          snap = { ...snap, observations: { ...snap.observations, queueTurn: true } };
          break;
        }
        if (a.why === "ci") {
          snap = { ...snap, observations: { ...snap.observations, ci: ci.shift() ?? "pass" } };
          break;
        }
        return out;
      case "complete":
        setEntry("done");
        break;
      case "sendBack":
        setEntry("sent_back", `to:${a.to}\n${a.note}`);
        break;
      default:
        return out;
    }
  }
  throw new Error(`no end after ${limit} actions: ${out.join(" | ")}`);
}

describe("reconcile() over Software, as today's Workflow runs it", () => {
  it("a small change: triage, the spec skipped, build, verify, merge through the queue, done", () => {
    expect(run(snapshot(SOFTWARE))).toEqual([
      "enter triage#1",
      "job triage.triage",
      "complete triage",
      "skip spec",
      "enter build#1",
      "job build.build",
      "complete build",
      "enter verify#1",
      "job verify.verify",
      "complete verify",
      "enter merge#1",
      "gate merge.gate (merge)",
      "wait queue",
      "op pr.merge",
      "complete merge",
      "done",
    ]);
  });

  it("a medium change: the planning session and the spec gate; changes requested runs it again", () => {
    const actions = run(snapshot(SOFTWARE, { size: "medium" }), {
      steps: { "spec.spec-gate": ["changes_requested", "approved"] },
    });
    expect(actions.slice(3, 9)).toEqual([
      "enter spec#1",
      "job spec.session",
      "gate spec.spec-gate (spec)",
      "job spec.session",
      "gate spec.spec-gate (spec)",
      "complete spec",
    ]);
    expect(actions.at(-1)).toBe("done");
  });

  it("the foreman's request: a small item gets a spec when it asks; large always does", () => {
    expect(run(snapshot(SOFTWARE, { specRequested: "require" }))).toContain("enter spec#1");
    expect(run(snapshot(SOFTWARE, { size: "large", specRequested: "skip" }))).toContain(
      "enter spec#1",
    );
  });

  it("unreleased: shaping runs, then it waits for release before the first delivery stage", () => {
    expect(run(snapshot(SOFTWARE, { size: "medium" }), { released: false })).toEqual([
      "enter triage#1",
      "job triage.triage",
      "complete triage",
      "enter spec#1",
      "job spec.session",
      "gate spec.spec-gate (spec)",
      "complete spec",
      "wait release",
    ]);
  });

  it("a failed verify goes back to build with the failures; CI pending waits for CI", () => {
    const actions = run(snapshot(SOFTWARE), {
      steps: {
        "verify.verify": [{ status: "ok", output: { failures: ["tests"] } }, "ok"],
      },
      ci: ["fail", "pending", "pass"],
    });
    expect(actions).toContain("sendBack verify → build");
    expect(actions.filter((a) => a === "enter build#2")).toHaveLength(1);
    expect(actions).toContain("wait ci");
    expect(actions.at(-1)).toBe("done");
  });

  it("a build that keeps failing fails the item after the retry limit", () => {
    const actions = run(snapshot(SOFTWARE, { retryLimit: 1 }), {
      steps: { "build.build": ["failed", "failed"] },
    });
    expect(actions.filter((a) => a === "job build.build")).toHaveLength(2);
    expect(actions.at(-1)).toBe("fail build");
  });

  it("checks that keep failing stop after the retry limit, not forever", () => {
    const actions = run(snapshot(SOFTWARE, { retryLimit: 1 }), { ci: ["fail", "fail", "fail"] });
    expect(actions.at(-1)).toBe("fail verify");
  });

  it("a send-back at the merge gate builds again; a rejected spec ends the item", () => {
    const back = run(snapshot(SOFTWARE), { steps: { "merge.gate": ["sent_back", "approved"] } });
    expect(back).toContain("sendBack merge → build");
    expect(back.at(-1)).toBe("done");
    const rejected = run(snapshot(SOFTWARE, { size: "large" }), {
      steps: { "spec.spec-gate": ["rejected"] },
    });
    expect(rejected.at(-1)).toBe("reject spec");
  });

  it("slot steps: a gate after the spec, an agent check by domain, a sign-off from large", () => {
    const parsed = parseProjectPolicy(
      JSON.stringify({
        version: 1,
        autonomyPolicy: "balanced",
        agents: [{ name: "Security", role: "review", tier: "light", instructions: "" }],
        workflows: [
          {
            name: "Gated",
            slots: {
              afterSpec: [{ id: "design", kind: "gate", name: "Design" }],
              beforeVerify: [
                {
                  id: "sec",
                  kind: "work",
                  name: "Security",
                  agent: "Security",
                  when: { domain: "auth" },
                },
              ],
              afterVerify: [
                { id: "sign-off", kind: "gate", name: "Sign-off", when: { sizeAtLeast: "large" } },
              ],
            },
            core: {},
          },
        ],
        workflow: "Gated",
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const def = compileProjectWorkflow(parsed.policy, "Gated");
    const small = run(snapshot(def));
    expect(small).toContain("gate design.decision (step)");
    expect(small).toContain("skip sec");
    expect(small).toContain("skip sign-off");
    const auth = run(snapshot(def, { size: "large", domains: ["auth"] }), {
      steps: {
        "sec.check": [{ status: "ok", output: { verdict: "sendBack", note: "look at auth" } }],
      },
    });
    expect(auth).toContain("sendBack sec → build");
    expect(auth).toContain("gate sign-off.decision (step)");
    expect(auth.at(-1)).toBe("done");
  });

  it("an attached PR: triage, checks on its own head, the merge directly", () => {
    expect(run(snapshot(ATTACHED_PR, { kind: "attached", size: "large" }))).toEqual([
      "enter triage#1",
      "job triage.triage",
      "complete triage",
      "enter verify#1",
      "job verify.verify",
      "complete verify",
      "enter merge#1",
      "gate merge.gate (merge)",
      "op pr.merge",
      "complete merge",
      "done",
    ]);
  });

  it("is pure, and a cancelled item waits; the idempotency key names the attempt", () => {
    const snap = snapshot(SOFTWARE);
    expect(reconcile(snap)).toEqual(reconcile(snap));
    expect(reconcile({ ...snap, item: { ...snap.item, cancelled: true } })).toEqual({
      kind: "wait",
      stageId: null,
      why: "cancelled",
    });
    expect(actionKey("wi_1", { stageId: "build", round: 2, stepId: "build", attempt: 1 })).toBe(
      "wi_1:build:2:build:1",
    );
  });
});
