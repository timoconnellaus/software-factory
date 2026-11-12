// The reconciler in shadow (spec 52 PR (c)): an ended item's stage history against what
// `reconcile()` predicts from the history just before each transition. Pure; the engine's tests run
// it against the real Workflow.
import { describe, expect, it } from "vitest";
import {
  ATTACHED_PR,
  type ItemSnapshot,
  KNOWN_DIFFERENCES,
  SHADOW_NOT_COMPARED,
  SHADOW_REQUIRED,
  SOFTWARE,
  type StageRow,
  shadowVerdict,
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

const rows = (...xs: string[]): StageRow[] =>
  xs.map((x) => {
    const [stage, status] = x.split(":") as [string, StageRow["status"]];
    return { stage, status };
  });

const said = (v: ReturnType<typeof shadowVerdict>) =>
  v.transitions.map((t) => (t.agrees ? t.observed : `${t.observed} ≠ ${t.predicted}`));

describe("shadowVerdict", () => {
  it("a small change agrees at every stage transition, and still diverges by what wasn't compared", () => {
    const v = shadowVerdict(
      SOFTWARE,
      item(),
      rows(
        "intake:done",
        "triage:done",
        "spec:skipped",
        "build:done",
        "verify:done",
        "merge:done",
        "done:done",
      ),
      "done",
    );
    expect(said(v)).toEqual([
      "enter triage",
      "skip spec",
      "enter build",
      "enter verify",
      "enter merge",
      "end done",
    ]);
    expect(v.uncompared).toEqual([...SHADOW_NOT_COMPARED]);
    expect(v.known).toEqual([]);
    expect(v.divergences).toBe(SHADOW_NOT_COMPARED.length);
    expect(SHADOW_NOT_COMPARED.length).toBeGreaterThan(0);
    expect(SHADOW_REQUIRED).toContain("stage order and skips");
  });

  it("a send-back's target is not taken from the reconciler: the next stage isn't compared, and diverges", () => {
    const v = shadowVerdict(
      SOFTWARE,
      item(),
      rows(
        "intake:done",
        "triage:done",
        "spec:skipped",
        "build:done",
        "verify:failed",
        "build:done",
        "verify:done",
        "merge:sent_back",
        "build:done",
        "verify:done",
        "merge:done",
        "done:done",
      ),
      "done",
    );
    const out = said(v);
    expect(out.filter((x) => x.includes("not compared: a send-back's target"))).toHaveLength(2);
    expect(out.at(-1)).toBe("end done");
    // A send-back to the wrong stage is still the wrong stage: the history says where it went.
    const wrong = shadowVerdict(
      SOFTWARE,
      item(),
      rows(
        "intake:done",
        "triage:done",
        "spec:skipped",
        "build:done",
        "verify:sent_back",
        "triage:done",
      ),
      "failed",
    );
    expect(said(wrong)).toContain(
      "enter triage ≠ not compared: a send-back's target (needs the steps)",
    );
  });

  it("an end other than Done is compared as a divergence, never skipped", () => {
    for (const end of ["failed", "rejected", "cancelled"] as const) {
      const v = shadowVerdict(
        SOFTWARE,
        item(),
        rows("intake:done", "triage:done", "spec:skipped", "build:failed"),
        end,
      );
      expect(v.transitions.at(-1)).toMatchObject({ observed: `end ${end}`, agrees: false });
      expect(v.divergences).toBe(1 + SHADOW_NOT_COMPARED.length);
    }
  });

  it("a divergence in stage order is recorded with what the reconciler would have done", () => {
    const v = shadowVerdict(
      SOFTWARE,
      item({ size: "medium" }),
      rows("intake:done", "triage:done", "spec:skipped", "build:done"),
      "cancelled",
    );
    expect(said(v)).toContain("skip spec ≠ enter spec");
  });

  it("an attached PR's own stages", () => {
    const v = shadowVerdict(
      ATTACHED_PR,
      item({ kind: "attached", size: "large" }),
      rows(
        "intake:done",
        "triage:done",
        "spec:skipped",
        "build:skipped",
        "verify:done",
        "merge:done",
        "done:done",
      ),
      "done",
    );
    expect(said(v)).toEqual([
      "enter triage",
      "skip spec",
      "skip build",
      "enter verify",
      "enter merge",
      "end done",
    ]);
  });
  it("a head that moved in the merge queue is reported by name, and counts as a divergence", () => {
    const history = rows(
      "intake:done",
      "triage:done",
      "spec:skipped",
      "build:done",
      "verify:done",
      "merge:done",
      "done:done",
    );
    const v = shadowVerdict(SOFTWARE, item(), history, "done", { queueHeadMoved: true });
    // The stage order still agrees: today's history shows the merge stage done, with no return to
    // Checks. The difference is the gate, so it is named, not hidden in a transition.
    expect(v.transitions.every((t) => t.agrees)).toBe(true);
    expect(v.known).toEqual([
      { reason: "queue-head-moved", note: KNOWN_DIFFERENCES["queue-head-moved"] },
    ]);
    expect(v.known[0]?.note).toMatch(/spec 53/);
    expect(v.divergences).toBe(SHADOW_NOT_COMPARED.length + 1);
  });
});
