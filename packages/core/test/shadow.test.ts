// The reconciler in shadow (spec 52 PR (c), made complete): an ended item's history (stage rows,
// jobs, gates and who decided them) replayed through `reconcile()`; at each thing the Workflow did,
// what the reconciler would have done. Pure; the engine's tests run it against the real Workflow.
import { describe, expect, it } from "vitest";
import {
  ATTACHED_PR,
  type GateRow,
  type ItemSnapshot,
  type JobRow,
  KNOWN_DIFFERENCES,
  SHADOW_NOT_COMPARED,
  type ShadowHistory,
  SOFTWARE,
  type StageInstance,
  type StageRow,
  shadowVerdict,
  type WorkflowDefinition,
} from "../src/stages/index.ts";

const item = (over: Partial<ItemSnapshot["item"]> = {}): ItemSnapshot["item"] => ({
  kind: "change",
  size: "small",
  domains: [],
  hasRepository: true,
  released: true,
  retryLimit: 2,
  ...over,
});

/** Builds a history in time order, the way today's Workflow writes it. */
function history() {
  let clock = 0;
  const t = () => new Date(Date.UTC(2026, 10, 13, 0, 0, clock++)).toISOString();
  const stages: StageRow[] = [];
  const jobs: JobRow[] = [];
  const gates: GateRow[] = [];
  const close = (status: StageRow["status"], at: string) => {
    const open = stages.at(-1);
    if (open && open.status === "active") {
      open.status = status;
      open.endedAt = at;
    }
  };
  const h = {
    stages,
    jobs,
    gates,
    /** `workItem.enterStage`: closes the active row (as `closeAs`) and opens one. */
    enter(stage: string, closeAs: StageRow["status"] = "done") {
      const at = t();
      close(closeAs, at);
      stages.push({ stage, status: "active", at });
      return h;
    },
    skip(stage: string) {
      stages.push({ stage, status: "skipped", at: t(), endedAt: null });
      return h;
    },
    job(stage: JobRow["stage"], status: "done" | "failed" = "done", extra: Partial<JobRow> = {}) {
      const at = t();
      jobs.push({
        stage,
        role: "implement",
        step: null,
        critic: false,
        adjudicate: false,
        status,
        at,
        endedAt: t(),
        ...extra,
      });
      return h;
    },
    gate(
      kind: GateRow["kind"],
      decision: string,
      extra: Partial<GateRow> = {},
      operation = kind === "spec" ? "spec.accept" : kind === "merge" ? "pr.merge" : "workflow.gate",
    ) {
      gates.push({
        kind,
        operation,
        step: null,
        status: decision === "approved" ? "approved" : "rejected",
        decision,
        at: t(),
        decidedAt: t(),
        byPerson: true,
        headSha: kind === "merge" ? "abc1234" : null,
        note: null,
        ...extra,
      });
      return h;
    },
    end(status: StageRow["status"] = "done"): ShadowHistory {
      close(status, t());
      return { stages, jobs, gates };
    },
  };
  return h;
}

const said = (v: ReturnType<typeof shadowVerdict>) =>
  v.transitions.map((t) => (t.agrees ? t.observed : `${t.observed} ≠ ${t.predicted}`));

const SECURITY: StageInstance = {
  id: "security",
  type: "agent-check",
  typeVersion: 1,
  name: "Security review",
  phase: "delivery",
  settings: { instructions: "Look at auth." },
  agent: "Security",
};
const withSlot = (slot: StageInstance): WorkflowDefinition => ({
  ...SOFTWARE,
  stages: [...SOFTWARE.stages.slice(0, 3), slot, ...SOFTWARE.stages.slice(3)],
});

/** A small change through to the merge gate's approval. */
const shipped = () =>
  history()
    .enter("triage")
    .job("triage")
    .skip("spec")
    .enter("build")
    .job("build")
    .enter("verify")
    .job("verify")
    .enter("merge")
    .gate("merge", "approved");

describe("shadowVerdict, complete", () => {
  it("compares everything: nothing is left uncompared, so the streak can count", () => {
    expect(SHADOW_NOT_COMPARED).toEqual([]);
  });

  it("a small change agrees on every stage, job, gate, who decided it, the merge and the end", () => {
    const v = shadowVerdict(SOFTWARE, item(), shipped().end(), "done");
    expect(said(v)).toEqual([
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
    expect(v.divergences).toBe(0);
  });

  it("a failed build retries in its stage, and a failed verify goes back to build: both agree", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build", "failed")
      .enter("build", "failed")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("build", "failed")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(SOFTWARE, item({ retryLimit: 3 }), h, "done");
    expect(said(v)).toContain("sendBack verify → build");
    expect(v.divergences).toBe(0);
  });

  it("past the retry limit the item fails, where the reconciler gives up too", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build", "failed")
      .enter("build", "failed")
      .job("build", "failed")
      .enter("build", "failed")
      .job("build", "failed")
      .end("failed");
    const v = shadowVerdict(SOFTWARE, item({ retryLimit: 2 }), h, "failed");
    expect(said(v).at(-1)).toBe("end failed");
    expect(v.divergences).toBe(0);
    // A retry the reconciler wouldn't have made is a divergence.
    const early = shadowVerdict(SOFTWARE, item({ retryLimit: 1 }), h, "failed");
    expect(early.divergences).toBeGreaterThan(0);
  });

  it("a slot step's send-back goes to the build, and a later pass goes on to verify", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build")
      .job("verify", "done", { step: "security", role: "review", verdict: "sendBack" })
      .enter("build", "failed")
      .job("build")
      .job("verify", "done", { step: "security", role: "review", verdict: "pass" })
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(withSlot(SECURITY), item(), h, "done");
    expect(said(v)).toEqual(
      expect.arrayContaining([
        "enter security",
        "job security check",
        "sendBack security → build",
        "complete security",
      ]),
    );
    expect(v.divergences).toBe(0);
  });

  it("a slot step whose condition doesn't hold runs nothing today, and the reconciler skips it", () => {
    const def = withSlot({ ...SECURITY, when: { domain: "auth" } });
    const v = shadowVerdict(def, item(), shipped().end(), "done");
    expect(said(v)).toContain("skip security");
    expect(v.divergences).toBe(0);
    // When its condition holds and nothing ran, that's a divergence.
    const holds = shadowVerdict(def, item({ domains: ["auth"] }), shipped().end(), "done");
    expect(said(holds)).toContain("skip security ≠ enter security");
  });

  it("a slot decision step: the gate, who decided it, and a send-back", () => {
    const design: StageInstance = {
      id: "design",
      type: "decision",
      typeVersion: 1,
      name: "Design sign-off",
      phase: "delivery",
      settings: {},
    };
    const def: WorkflowDefinition = {
      ...SOFTWARE,
      stages: [...SOFTWARE.stages.slice(0, 4), design, SOFTWARE.stages[4] as StageInstance],
    };
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify")
      .gate("approval", "sent_back", { step: "design" })
      .enter("build", "failed")
      .job("build")
      .enter("verify")
      .job("verify")
      .gate("approval", "approved", { step: "design" })
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(def, item({ retryLimit: 3 }), h, "done");
    expect(said(v)).toEqual(
      expect.arrayContaining([
        "gate design decision",
        "design decision decided by a person",
        "sendBack design → build",
      ]),
    );
    expect(v.divergences).toBe(0);
  });

  it("a merge gate decided by anything but a person is a divergence", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved", { byPerson: false })
      .end();
    const v = shadowVerdict(SOFTWARE, item(), h, "done");
    expect(said(v)).toContain("merge gate decided by the factory ≠ merge gate decided by a person");
  });

  it("the spec gate: changes requested go back to the same session; a rejection ends it", () => {
    const planned = () =>
      history()
        .enter("triage")
        .job("triage")
        .enter("spec")
        .job("planning", "done", { role: "spec" })
        .gate("spec", "changes_requested");
    const approved = planned()
      .gate("spec", "approved")
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(SOFTWARE, item({ size: "medium" }), approved, "done");
    expect(said(v)).toEqual(
      expect.arrayContaining(["job spec session", "gate spec spec-gate", "complete spec"]),
    );
    expect(v.divergences).toBe(0);
    const rejected = shadowVerdict(
      SOFTWARE,
      item({ size: "medium" }),
      planned().gate("spec", "rejected").end("done"),
      "rejected",
    );
    expect(said(rejected).at(-1)).toBe("end rejected");
    expect(rejected.divergences).toBe(0);
  });

  it("the spec critic and the adjudicator's runs aren't steps of a stage", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .enter("spec")
      .job("planning", "done", { role: "spec" })
      .job("spec", "done", { role: "review", critic: true })
      .job("verify", "done", { role: "review", adjudicate: true })
      .gate("spec", "approved")
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    expect(shadowVerdict(SOFTWARE, item({ size: "medium" }), h, "done").divergences).toBe(0);
  });

  it("a cancelled item ends where it was", () => {
    const h = history().enter("triage").job("triage").skip("spec").enter("build").end("cancelled");
    const v = shadowVerdict(SOFTWARE, item(), h, "cancelled");
    expect(said(v).at(-1)).toBe("end cancelled");
    expect(v.divergences).toBe(0);
  });

  it("an attached PR's own stages", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .skip("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(ATTACHED_PR, item({ kind: "attached", size: "large" }), h, "done");
    expect(said(v)).toEqual(
      expect.arrayContaining(["skip spec", "skip build", "enter verify", "end done"]),
    );
    expect(v.divergences).toBe(0);
  });

  it("the babysitter's withdrawal goes back to verify the new head, and its carried approval lands it (v12)", () => {
    const h = shipped().enter("verify", "sent_back").job("verify").enter("merge").end();
    const v = shadowVerdict(SOFTWARE, item(), h, "done", { babysitter: true });
    expect(said(v)).toEqual(
      expect.arrayContaining(["sendBack merge → verify", "operation merge", "end done"]),
    );
    expect(v.divergences).toBe(0);
  });

  it("a head the merge queue moved: settled for the babysitter, named before it", () => {
    const h = shipped().end();
    const settled = shadowVerdict(SOFTWARE, item(), h, "done", {
      queueHeadMoved: true,
      babysitter: true,
    });
    expect(settled.known).toEqual([]);
    expect(settled.divergences).toBe(0);
    const before = shadowVerdict(SOFTWARE, item(), h, "done", { queueHeadMoved: true });
    expect(before.known).toEqual([
      { reason: "queue-head-moved", note: KNOWN_DIFFERENCES["queue-head-moved"] },
    ]);
    expect(before.divergences).toBe(1);
  });

  it("a divergence in stage order is recorded with what the reconciler would have done", () => {
    const h = history().enter("triage").job("triage").skip("spec").enter("build").end("cancelled");
    const v = shadowVerdict(SOFTWARE, item({ size: "medium" }), h, "cancelled");
    expect(said(v)).toContain("skip spec ≠ enter spec");
  });
});
