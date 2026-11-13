// The reconciler in shadow (spec 52 PR (c), made complete): an ended item's history (stage rows,
// jobs, gates and who decided them) replayed through `reconcile()`; at each thing the Workflow did,
// what the reconciler would have done. Pure; the engine's tests run it against the real Workflow.
import { describe, expect, it } from "vitest";
import { assemblePacket } from "../src/index.ts";
import {
  ATTACHED_PR,
  COVERAGE,
  type GateRow,
  type ItemSnapshot,
  type JobRow,
  KNOWN_DIFFERENCES,
  NOT_MODELLED,
  type PacketRow,
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
  const packets: PacketRow[] = [];
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
    job(
      stage: JobRow["stage"],
      status: "done" | "failed" = "done",
      { packet, ...extra }: Partial<JobRow> & { packet?: "pass" | "fail" } = {},
    ) {
      const at = t();
      // The verify run's review packet: what the checks stage reads (default: it passed).
      if (stage === "verify" && !extra.step && !extra.adjudicate && status === "done")
        packets.push({ headSha: "abc1234", verdict: packet ?? "pass", at });
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
      return { stages, jobs, gates, packets };
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
      .job("verify", "done", { packet: "fail" })
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
    expect(said(v)).toContain(
      "merge gate decided by the factory (unknown) ≠ merge gate decided by a person",
    );
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

  it("the spec critic and the adjudicator's runs are compared with the settings that call them", () => {
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
    // With the critic off and the adjudicator off, both runs diverge.
    const off = shadowVerdict(SOFTWARE, item({ size: "medium" }), h, "done");
    expect(said(off)).toEqual(
      expect.arrayContaining([
        "spec critic ran ≠ no spec critic (the setting is off)",
        "adjudicator asked (?) ≠ no adjudicator for ?",
      ]),
    );
    const critic: WorkflowDefinition = {
      ...SOFTWARE,
      stages: SOFTWARE.stages.map((s) =>
        s.id === "spec" ? { ...s, settings: { ...(s.settings as object), critic: true } } : s,
      ),
    };
    const on = shadowVerdict(critic, item({ size: "medium" }), h, "done", {
      adjudicator: { spec: "shadow", step: "off", "?": "shadow" } as never,
    });
    expect(on.divergences).toBe(0);
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

describe("nothing is dropped silently (review of #148)", () => {
  it("a gate, a re-pin, a release choice, a question, parking, kept designs or a release flag the reconciler doesn't model keeps the item from counting", () => {
    const base = () => shipped().end();
    const unmodelled = shadowVerdict(
      SOFTWARE,
      item(),
      {
        ...base(),
        gates: [
          ...(base().gates ?? []),
          {
            kind: "approval",
            operation: "pr.open",
            step: null,
            status: "approved",
            decision: "approved",
            at: "2026-11-13T00:00:30.000Z",
            decidedAt: "2026-11-13T00:00:31.000Z",
            byPerson: true,
            headSha: null,
            note: null,
          },
        ],
      },
      "done",
    );
    expect(unmodelled.uncompared).toEqual(["a gate the reconciler doesn't model: pr.open"]);
    expect(unmodelled.divergences).toBe(1);
    for (const kind of ["repin", "releaseChoice", "question", "parked"] as const) {
      const v = shadowVerdict(SOFTWARE, item(), { ...base(), events: [{ kind, at: "x" }] }, "done");
      expect(v.uncompared, kind).toEqual([NOT_MODELLED[kind]]);
    }
    expect(
      shadowVerdict(SOFTWARE, item(), base(), "done", { keptDesigns: true }).uncompared,
    ).toEqual([NOT_MODELLED.keptDesigns]);
    expect(
      shadowVerdict(SOFTWARE, item(), base(), "done", { releaseFlag: true }).uncompared,
    ).toEqual([NOT_MODELLED.releaseFlag]);
  });

  it("checks reads the packet's verdict, not the Workflow's outcome: a Workflow that moved on against its packet diverges", () => {
    const h = history()
      .enter("triage")
      .job("triage")
      .skip("spec")
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify", "done", { packet: "fail" })
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(SOFTWARE, item(), h, "done");
    expect(said(v)).toContain("complete verify ≠ sendBack verify → build");
    // No packet at all: not compared, and named.
    const none = shadowVerdict(SOFTWARE, item(), { ...shipped().end(), packets: [] }, "done");
    expect(none.uncompared).toEqual([NOT_MODELLED.noPacket]);
  });

  it("the adjudicator's decision counts only where it had earned it", () => {
    const decided = (adjudication: GateRow["adjudication"]) => {
      const h = history()
        .enter("triage")
        .job("triage")
        .enter("spec")
        .job("planning", "done", { role: "spec" })
        .gate("spec", "approved", { byPerson: false, decidedBy: "improver", adjudication })
        .enter("build")
        .job("build")
        .enter("verify")
        .job("verify")
        .enter("merge")
        .gate("merge", "approved")
        .end();
      return shadowVerdict(SOFTWARE, item({ size: "medium" }), h, "done");
    };
    expect(decided({ mode: "active", acted: true }).divergences).toBe(0);
    expect(said(decided({ mode: "shadow", acted: false }))).toContain(
      "spec spec-gate decided by the factory (improver) ≠ spec spec-gate decided by a person or the adjudicator, having earned it",
    );
  });

  it("a shaped item waits for its release: a point of its own", () => {
    const h = history().enter("triage").job("triage").skip("spec");
    const rest = h.enter("build").job("build").enter("verify").job("verify").enter("merge");
    const full = rest.gate("merge", "approved").end();
    // Released between the shaping stages and the build.
    const released = full.stages.find((r) => r.stage === "build")?.at as string;
    const v = shadowVerdict(SOFTWARE, item({ released: false }), full, "done", {
      releasedAt: new Date(Date.parse(released) - 500).toISOString(),
    });
    expect(said(v)).toContain("wait release");
    expect(v.divergences).toBe(0);
  });

  it("an attached PR's absent stages are a named equivalence; each verdict says what it covered", () => {
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
    expect(v.equivalences?.map((e) => e.reason)).toEqual(["absent-stage-skipped"]);
    expect(v.covers).toEqual(["an attached PR"]);
    expect(COVERAGE).toHaveLength(9);
  });
});

/** A packet's input whose only difference is CI on the head: green passes, red fails. */
const packetInput = (green: boolean): Parameters<typeof assemblePacket>[0] => ({
  headSha: "a".repeat(40),
  evidence: {
    summary: "",
    criteria: [{ criterion: "A", met: true, evidence: "x" }],
    checks: [],
    reviewer: { role: "review", verdict: "approve", notes: "" },
    riskFlags: [],
  },
  ci: green
    ? { state: "success", checks: [], failing: [], pending: [] }
    : { state: "failure", checks: [], failing: ["ci"], pending: [] },
  files: [],
  sameModelAsImplementer: false,
});

describe("the second review of #148", () => {
  it("an absent stage's skip is an equivalence only for an attached PR", () => {
    const h = shipped().end();
    const v = shadowVerdict(
      SOFTWARE,
      item(),
      { ...h, stages: [...h.stages, { stage: "deploy", status: "skipped", at: "z" }] },
      "done",
    );
    expect(v.uncompared).toEqual(["a skip of a stage the workflow doesn't have: deploy"]);
  });

  it("a cancelled stage row is replayed, and one the workflow lacks is named", () => {
    const h = history().enter("triage").job("triage").skip("spec").enter("build").end("cancelled");
    const lacks = shadowVerdict(
      SOFTWARE,
      item(),
      { ...h, stages: [...h.stages, { stage: "deploy", status: "cancelled", at: "z" }] },
      "cancelled",
    );
    expect(lacks.uncompared).toEqual(["a stage the workflow doesn't have: deploy"]);
    const ok = shadowVerdict(SOFTWARE, item(), h, "cancelled");
    expect(ok.divergences).toBe(0);
  });

  it("a critic or an adjudicator the settings call for that never ran is a divergence", () => {
    const critic: WorkflowDefinition = {
      ...SOFTWARE,
      stages: SOFTWARE.stages.map((s) =>
        s.id === "spec" ? { ...s, settings: { ...(s.settings as object), critic: true } } : s,
      ),
    };
    const h = history()
      .enter("triage")
      .job("triage")
      .enter("spec")
      .job("planning", "done", { role: "spec" })
      .gate("spec", "approved", { id: "pa_spec" })
      .enter("build")
      .job("build")
      .enter("verify")
      .job("verify")
      .enter("merge")
      .gate("merge", "approved")
      .end();
    const v = shadowVerdict(critic, item({ size: "medium" }), h, "done", {
      adjudicator: { spec: "shadow", step: "off" },
    });
    expect(said(v)).toEqual(
      expect.arrayContaining([
        "no spec critic ran ≠ spec critic ran",
        "no adjudicator on a spec gate ≠ adjudicator asked (spec)",
      ]),
    );
  });

  it("checks reads exactly the verdict assemblePacket computes", () => {
    // The reconciler's checks stage is fed the stored packet's verdict; at the switch-over it reads
    // the same function. Here the function's own verdicts decide the replay.
    const verdicts = (["pass", "fail"] as const).map((want) => {
      const packet = assemblePacket(packetInput(want === "pass"));
      return packet.verdict;
    });
    expect(verdicts).toEqual(["pass", "fail"]);
    const replay = (verdict: "pass" | "fail") =>
      said(
        shadowVerdict(
          SOFTWARE,
          item(),
          history()
            .enter("triage")
            .job("triage")
            .skip("spec")
            .enter("build")
            .job("build")
            .enter("verify")
            .job("verify", "done", { packet: verdict })
            .enter("merge")
            .gate("merge", "approved")
            .end(),
          "done",
        ),
      );
    expect(replay(verdicts[0] as "pass")).toContain("complete verify");
    expect(replay(verdicts[1] as "fail")).toContain("complete verify ≠ sendBack verify → build");
  });
});
