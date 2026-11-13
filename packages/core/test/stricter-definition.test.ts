// Adopting only a newer org version's tightenings (review of #139): a running item whose org saved a
// version that both loosens and tightens takes the tightened stages and keeps what was loosened.
import { describe, expect, it } from "vitest";
import {
  SOFTWARE,
  type StageInstance,
  stricterDefinition,
  type WorkflowDefinition,
  workflowImpact,
} from "../src/stages/index.ts";

const withStages = (
  def: WorkflowDefinition,
  edit: (s: StageInstance[]) => StageInstance[],
): WorkflowDefinition => ({ ...def, stages: edit(def.stages.map((s) => ({ ...s }))) });

const SECURITY: StageInstance = {
  id: "security",
  type: "agent-check",
  typeVersion: 1,
  name: "Security review",
  phase: "delivery",
  settings: {},
};
const NO_AGENTS = { before: [], after: [] };
const onlySummary = (def: WorkflowDefinition) =>
  withStages(def, (s) =>
    s.map((x) => (x.id === "verify" ? { ...x, settings: { sections: ["summary"] } } : x)),
  );
const ids = (def: WorkflowDefinition) => def.stages.map((s) => s.id);

describe("stricterDefinition", () => {
  it("takes a stage the newer version tightens and keeps one it loosens", () => {
    // Pinned: a security check, and the review packet cut to its summary.
    const pinned = onlySummary(
      withStages(SOFTWARE, (s) => [...s.slice(0, 3), SECURITY, ...s.slice(3)]),
    );
    // Newer: every section again (tightens), and the security check dropped (loosens).
    const newer = SOFTWARE;
    expect(workflowImpact(pinned, newer).class).toBe("loosens");
    const { def, adopted } = stricterDefinition(pinned, newer, NO_AGENTS);
    expect(ids(def)).toEqual(["triage", "spec", "build", "security", "verify", "merge"]);
    expect(def.stages.find((s) => s.id === "verify")?.settings).toEqual(
      SOFTWARE.stages.find((s) => s.id === "verify")?.settings,
    );
    expect(adopted.length).toBeGreaterThan(0);
    expect(adopted.every((c) => c.class === "tightens")).toBe(true);
    // Against what the item pinned, the result only tightens.
    expect(workflowImpact(pinned, def).class).toBe("tightens");
  });

  it("adds a stage only the newer version has, after the stage it follows there", () => {
    const pinned = onlySummary(SOFTWARE);
    const newer = withStages(SOFTWARE, (s) => [...s.slice(0, 3), SECURITY, ...s.slice(3)]);
    const { def, adopted } = stricterDefinition(pinned, newer, NO_AGENTS);
    expect(ids(def)).toEqual(["triage", "spec", "build", "security", "verify", "merge"]);
    // The verify packet change is adopted too: every section is a tightening.
    expect(adopted.some((c) => c.path.startsWith("stages.security"))).toBe(true);
    expect(workflowImpact(pinned, def).class).toBe("tightens");
  });

  it("adopts nothing when the newer version only loosens", () => {
    const { def, adopted } = stricterDefinition(SOFTWARE, onlySummary(SOFTWARE), NO_AGENTS);
    expect(adopted).toEqual([]);
    expect(def.stages).toEqual(SOFTWARE.stages);
  });
});
