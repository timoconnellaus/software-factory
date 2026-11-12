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
  /** Pushes to the PR's head after the merge gate's nth decision (1-based): the head moves. */
  pushAfterGate?: number[];
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
    case "flag":
      return `flag ${a.stageId ?? "-"}`;
    case "repin":
      return `repin v${a.version}`;
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
  // The PR's head: each build makes a new one; a scripted push moves it.
  let heads = 0;
  let head = "0".repeat(40);
  const nextHead = () => {
    heads++;
    head = heads.toString(16).padStart(40, "0");
  };
  let mergeGates = 0;
  const setEntry = (status: StageEntry["status"], note?: string, free?: boolean) => {
    const stages = [...snap.stages];
    const last = stages.at(-1) as StageEntry;
    stages[stages.length - 1] = {
      ...last,
      status,
      ...(note !== undefined ? { note } : {}),
      ...(free ? { free } : {}),
    };
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
          observations: { headSha: head },
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
            {
              stageId: a.stageId,
              round,
              stepId: a.stepId,
              attempt: 1,
              status: "running",
              ...(a.kind === "gate" ? { headSha: head } : {}),
            },
          ],
        };
        if (a.kind === "operation") {
          snap = { ...snap, observations: { ...snap.observations, merged: true } };
          settle(`${a.stageId}.${a.stepId}`, "ok");
        } else settle(`${a.stageId}.${a.stepId}`, a.kind === "gate" ? "approved" : "ok");
        if (a.kind === "job" && a.stepId === "build" && snap.steps.at(-1)?.status === "ok")
          nextHead();
        if (a.kind === "gate" && a.gateKind === "merge") {
          mergeGates++;
          if (script.pushAfterGate?.includes(mergeGates)) nextHead();
        }
        snap = { ...snap, observations: { ...snap.observations, headSha: head } };
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
        setEntry("sent_back", `to:${a.to}\n${a.note}`, a.free);
        break;
      case "repin":
        if (!snap.latest) throw new Error("repin with no latest version");
        snap = {
          ...snap,
          definition: snap.latest.definition,
          version: snap.latest.version,
          latest: undefined,
        };
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

describe("the second review: limits, missing stages, versions and the head", () => {
  const gated = () => {
    const parsed = parseProjectPolicy(
      JSON.stringify({
        version: 1,
        autonomyPolicy: "balanced",
        agents: [{ name: "Security", role: "review", tier: "light", instructions: "" }],
        workflows: [
          {
            name: "Gated",
            slots: {
              beforeVerify: [{ id: "sec", kind: "work", name: "Security", agent: "Security" }],
            },
            core: {},
          },
        ],
        workflow: "Gated",
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return compileProjectWorkflow(parsed.policy, "Gated");
  };
  const sendBack = { status: "ok" as const, output: { verdict: "sendBack" as const, note: "no" } };

  it("an agent check's send-backs are bounded: the item fails after the retry limit, as today", () => {
    const actions = run(snapshot(gated(), { retryLimit: 2 }), {
      steps: { "sec.check": Array.from({ length: 10 }, () => sendBack) },
    });
    expect(actions.filter((a) => a === "job build.build")).toHaveLength(3);
    expect(actions.at(-1)).toBe("fail sec");
  });

  it("a person's merge send-backs don't count toward the limit (today's Workflow doesn't count them)", () => {
    const actions = run(snapshot(SOFTWARE, { retryLimit: 1 }), {
      steps: { "merge.gate": ["sent_back", "sent_back", "sent_back", "approved"] },
    });
    expect(actions.filter((a) => a === "job build.build")).toHaveLength(4);
    expect(actions.at(-1)).toBe("done");
  });

  it("failures are counted across the item: build attempts stop at the retry limit plus one", () => {
    // Each round: one failed build, then a good one whose checks fail. Per-entry counting allowed
    // (limit + 1)² builds; today's Workflow allows limit + 1 failures in all.
    const actions = run(snapshot(SOFTWARE, { retryLimit: 2 }), {
      steps: { "build.build": ["failed", "ok", "failed", "ok", "failed", "ok"] },
      ci: ["fail", "fail", "fail"],
    });
    expect(actions.filter((a) => a === "job build.build").length).toBeLessThanOrEqual(3);
    expect(actions.at(-1)).toMatch(/^fail /);
  });

  it("a send-back to a stage no longer in the definition flags the item; it never restarts at Triage", () => {
    const snap = snapshot(SOFTWARE);
    const flagged = reconcile({
      ...snap,
      definition: { ...SOFTWARE, stages: SOFTWARE.stages.filter((s) => s.id !== "build") },
      stages: [
        { stageId: "triage", round: 1, typeVersion: 1, status: "done" },
        { stageId: "verify", round: 1, typeVersion: 1, status: "sent_back", note: "to:build\nfix" },
      ],
    });
    expect(flagged.kind).toBe("flag");
    expect(flagged).toMatchObject({ stageId: "verify" });
  });

  it("a current stage removed from the definition flags the item, never fails it", () => {
    const snap = snapshot(SOFTWARE);
    const without = { ...SOFTWARE, stages: SOFTWARE.stages.filter((s) => s.id !== "verify") };
    for (const status of ["active", "done"] as const)
      expect(
        reconcile({
          ...snap,
          definition: without,
          stages: [{ stageId: "verify", round: 1, typeVersion: 1, status }],
        }).kind,
      ).toBe("flag");
  });

  it("Q3: a tightening version reaches a running item at its next stage boundary; a loosening doesn't", () => {
    const tighter = {
      ...SOFTWARE,
      stages: [
        ...SOFTWARE.stages.slice(0, 4),
        {
          ...SOFTWARE.stages[0],
          id: "sign-off",
          type: "decision",
          name: "Sign-off",
          phase: "delivery" as const,
          settings: {},
        },
        ...SOFTWARE.stages.slice(4),
      ],
    } as WorkflowDefinition;
    const mid: ItemSnapshot = {
      ...snapshot(SOFTWARE),
      version: 1,
      stages: [
        { stageId: "triage", round: 1, typeVersion: 1, status: "done" },
        { stageId: "spec", round: 1, typeVersion: 1, status: "skipped" },
        { stageId: "build", round: 1, typeVersion: 1, status: "done" },
      ],
    };
    expect(reconcile({ ...mid, latest: { version: 2, definition: tighter } })).toMatchObject({
      kind: "repin",
      version: 2,
    });
    const actions = run({ ...mid, latest: { version: 2, definition: tighter } });
    expect(actions).toContain("gate sign-off.decision (step)");
    // Not inside a stage: the active entry finishes under the version it started on.
    const active = {
      ...mid,
      stages: [
        ...mid.stages,
        { stageId: "verify", round: 1, typeVersion: 1, status: "active" as const },
      ],
    };
    expect(reconcile({ ...active, latest: { version: 2, definition: tighter } }).kind).toBe("job");
    // From the tighter version back to Software is a loosening: it never reaches the item.
    const looser = reconcile({
      ...mid,
      definition: tighter,
      latest: { version: 3, definition: SOFTWARE },
    });
    expect(looser.kind).toBe("enter");
  });

  it("Q4: at release the item takes the current version if its shaping stages are unchanged, else a person chooses", () => {
    const shaped: ItemSnapshot = {
      ...snapshot(SOFTWARE, { size: "medium" }),
      version: 1,
      stages: [
        { stageId: "triage", round: 1, typeVersion: 1, status: "done" },
        { stageId: "spec", round: 1, typeVersion: 1, status: "done" },
      ],
    };
    const sameShaping = {
      ...SOFTWARE,
      stages: SOFTWARE.stages.map((s) =>
        s.id === "build" ? { ...s, settings: { retryLimit: 1 } } : s,
      ),
    };
    expect(reconcile({ ...shaped, latest: { version: 2, definition: sameShaping } }).kind).toBe(
      "repin",
    );
    const newShaping = {
      ...SOFTWARE,
      stages: SOFTWARE.stages.map((s) =>
        s.id === "spec" ? { ...s, settings: { critic: true } } : s,
      ),
    };
    expect(reconcile({ ...shaped, latest: { version: 2, definition: newShaping } })).toMatchObject({
      kind: "flag",
      stageId: null,
    });
    // Unreleased, it shapes on: the choice is at release.
    expect(
      reconcile({
        ...shaped,
        item: { ...shaped.item, released: false },
        latest: { version: 2, definition: newShaping },
      }),
    ).toEqual({ kind: "wait", stageId: null, why: "release" });
  });

  it("the merge approval holds for the head it was given on: a push after it checks and decides again", () => {
    const actions = run(snapshot(SOFTWARE), { pushAfterGate: [1] });
    expect(actions).toContain("sendBack merge → verify");
    expect(actions.filter((a) => a === "gate merge.gate (merge)")).toHaveLength(2);
    expect(actions.filter((a) => a === "job build.build")).toHaveLength(1);
    expect(actions.at(-1)).toBe("done");
  });

  it("the gate action carries the gate spec's alwaysReview", () => {
    const parsed = gated();
    const snap = snapshot(parsed);
    const step = reconcile({
      ...snap,
      definition: SOFTWARE,
      stages: [{ stageId: "merge", round: 1, typeVersion: 1, status: "active" }],
    });
    expect(step).toMatchObject({ kind: "gate", gateKind: "merge", alwaysReview: true });
    const spec = reconcile({
      ...snap,
      definition: SOFTWARE,
      stages: [{ stageId: "spec", round: 1, typeVersion: 1, status: "active" }],
      steps: [{ stageId: "spec", round: 1, stepId: "session", attempt: 1, status: "ok" }],
    });
    expect(spec).toMatchObject({ kind: "gate", gateKind: "spec", alwaysReview: false });
  });
});
