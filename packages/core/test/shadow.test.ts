// The reconciler in shadow (spec 52 PR (c)): each stage transition the Workflow makes, against what
// `reconcile()` predicts from the history just before it. Pure; the engine's tests run it against
// the real Workflow.
import { describe, expect, it } from "vitest";
import { parseProjectPolicy } from "../src/index.ts";
import {
  ATTACHED_PR,
  compileProjectWorkflow,
  type ItemSnapshot,
  type ObservedTransition,
  SOFTWARE,
  type StageRow,
  shadowCompare,
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

/** Plays a stage history one transition at a time, as `workItem.enterStage` reports them. */
function play(
  def: Parameters<typeof shadowCompare>[0],
  facts: ItemSnapshot["item"],
  steps: { observed: ObservedTransition[]; closeAs?: StageRow["status"] }[],
) {
  const rows: StageRow[] = [{ stage: "intake", status: "done" }];
  const out: string[] = [];
  for (const s of steps) {
    const open = rows.findLastIndex((r) => r.status === "active");
    if (open >= 0) rows[open] = { ...(rows[open] as StageRow), status: s.closeAs ?? "done" };
    for (const c of shadowCompare(def, facts, rows, s.observed))
      out.push(`${c.observed}${c.agrees ? "" : ` (predicted ${c.predicted})`}`);
    for (const t of s.observed) {
      if (t.kind === "end") rows.push({ stage: "done", status: "done" });
      else if (t.kind === "skip") rows.push({ stage: t.stage, status: "skipped" });
      else rows.push({ stage: t.stage, status: t.stage === "done" ? "done" : "active" });
    }
  }
  return out;
}

const enter = (stage: string): ObservedTransition => ({ kind: "enter", stage });
const skip = (stage: string): ObservedTransition => ({ kind: "skip", stage });

describe("shadowCompare", () => {
  it("a small change agrees at every transition", () => {
    expect(
      play(SOFTWARE, item(), [
        { observed: [enter("triage")] },
        { observed: [skip("spec"), enter("build")] },
        { observed: [enter("verify")] },
        { observed: [enter("merge")] },
        { observed: [enter("done")] },
      ]),
    ).toEqual([
      "enter triage",
      "skip spec",
      "enter build",
      "enter verify",
      "enter merge",
      "end done",
    ]);
  });

  it("a failed verify and a merge send-back both go back to build, and agree", () => {
    expect(
      play(SOFTWARE, item(), [
        { observed: [enter("triage")] },
        { observed: [skip("spec"), enter("build")] },
        { observed: [enter("verify")] },
        { observed: [enter("build")], closeAs: "failed" },
        { observed: [enter("verify")] },
        { observed: [enter("merge")] },
        { observed: [enter("build")], closeAs: "sent_back" },
        { observed: [enter("verify")] },
        { observed: [enter("merge")] },
        { observed: [enter("done")] },
      ]).every((x) => !x.includes("predicted")),
    ).toBe(true);
  });

  it("a divergence is recorded with what the reconciler would have done", () => {
    // The Workflow skips the spec of a medium item: the reconciler would have entered it.
    const out = play(SOFTWARE, item({ size: "medium" }), [
      { observed: [enter("triage")] },
      { observed: [skip("spec"), enter("build")] },
    ]);
    expect(out).toContain("skip spec (predicted enter spec)");
  });

  it("the foreman asking for a spec on a small item, and an attached PR's own stages", () => {
    expect(
      play(SOFTWARE, item({ specRequested: "require" }), [
        { observed: [enter("triage")] },
        { observed: [enter("spec")] },
        { observed: [enter("build")] },
      ]),
    ).toEqual(["enter triage", "enter spec", "enter build"]);
    expect(
      play(ATTACHED_PR, item({ kind: "attached", size: "large" }), [
        { observed: [enter("triage")] },
        { observed: [skip("spec"), skip("build"), enter("verify")] },
        { observed: [enter("merge")] },
        { observed: [enter("done")] },
      ]),
    ).toEqual([
      "enter triage",
      "skip spec",
      "skip build",
      "enter verify",
      "enter merge",
      "end done",
    ]);
  });

  it("slot steps aren't stages in today's history, so they aren't compared", () => {
    const parsed = parseProjectPolicy(
      JSON.stringify({
        version: 1,
        autonomyPolicy: "balanced",
        workflows: [
          {
            name: "Gated",
            slots: { afterSpec: [{ id: "design", kind: "gate", name: "Design" }] },
            core: {},
          },
        ],
        workflow: "Gated",
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const def = compileProjectWorkflow(parsed.policy, "Gated");
    expect(
      play(def, item(), [
        { observed: [enter("triage")] },
        { observed: [skip("spec"), enter("build")] },
      ]),
    ).toEqual(["enter triage", "skip spec", "enter build"]);
  });
});
