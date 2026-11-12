// The Policy, Agents and Workflows pages' wording (spec 41, slice 5), from a config document as
// `config.get` returns it. The defaults these pages assume for a field the document leaves out are
// pinned to the schema's, so they can't drift.
import { projectPolicySchema } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { POLICY_DOC } from "../screenshots/fixtures.ts";
import {
  agentRows,
  modelRoleRows,
  POLICY_DEFAULTS,
  policySections,
  skeleton,
  versionLine,
  workflowList,
} from "../src/mainview/lib/config-view.ts";
import { tabTitle } from "../src/mainview/lib/places.ts";

const value = (doc: Record<string, unknown>, key: string) =>
  policySections(doc)
    .flatMap((s) => s.rows)
    .find((r) => r.key === key)?.value;

describe("policy", () => {
  it("assumes the schema's defaults for what a document leaves out", () => {
    const p = projectPolicySchema.parse({ version: 1, autonomyPolicy: "balanced" });
    expect(POLICY_DEFAULTS).toEqual({
      specRequiredFrom: p.spec.requiredFrom,
      gateHours: p.timeouts.gateHours,
      questionHours: p.timeouts.questionHours,
      wipLimit: p.wipLimit,
      activeLimit: p.activeLimit,
      shapingLimit: p.shapingLimit,
      releaseAgents: p.release.agents,
      retryLimit: p.retryLimit,
      protectionOnRed: p.protection.onRed,
      improveEnabled: p.improve.enabled,
      improveTrialSize: p.improve.trialSize,
      improveWeeklyCap: p.improve.weeklyCap,
      adjudicatorSpec: p.adjudicator.spec,
      adjudicatorStep: p.adjudicator.step,
    });
  });

  it("words the document's rules, and the fixed floor", () => {
    expect(value(POLICY_DOC, "autonomy")).toBe("Balanced");
    expect(value(POLICY_DOC, "spec")).toBe("Needed from medium up");
    expect(value(POLICY_DOC, "wip")).toBe("At most 3 items");
    expect(value(POLICY_DOC, "approvers")).toBe("owner");
    expect(value(POLICY_DOC, "merge")).toBe("Always a person");
    const bare = { version: 1, autonomyPolicy: "cautious", spec: { requiredFrom: "small" } };
    expect(value(bare, "spec")).toBe("Needed for every item");
    expect(value(bare, "gate-timeout")).toBe("3 days");
    expect(value(bare, "approvers")).toBe("The org's owners and admins");
    expect(value({ ...bare, release: { agents: true } }, "release")).toBe(
      "People, agents and chat",
    );
  });

  it("says which version is current", () => {
    expect(versionLine({ version: 12, source: "app", createdBy: "owner" })).toBe(
      "Version 12, from app, by owner.",
    );
    expect(versionLine(null)).toBe("No config yet.");
  });
});

describe("agents", () => {
  it("lists agents with where the workflows use them", () => {
    expect(agentRows(POLICY_DOC).map((a) => [a.name, a.tier, a.lines, a.usedBy])).toEqual([
      ["Builder", "standard", 4, ["Software: build"]],
      ["Spec critic", "light", 2, ["Software: Spec critic"]],
    ]);
  });

  it("shows a model role's choice only when the project made one", () => {
    const rows = modelRoleRows({ modelRoles: { "review.light": "chosen-model" } });
    expect(rows.find((r) => r.role === "review")).toEqual({
      role: "review",
      standard: null,
      light: "chosen-model",
    });
  });
});

describe("workflows", () => {
  it("marks the one the project runs and fills the skeleton's slots", () => {
    const list = workflowList(POLICY_DOC);
    expect(list.map((w) => [w.name, w.stepCount, w.current])).toEqual([
      ["Software", 2, true],
      ["Docs", 0, false],
    ]);
    const stages = skeleton(POLICY_DOC, list[0] ?? null);
    expect(stages.map((s) => s.stage)).toEqual(["Spec", "Build", "Verify", "Review", "Merge"]);
    expect(stages[0]?.after?.steps.map((s) => [s.name, s.who])).toEqual([
      ["Spec critic", "Spec critic"],
    ]);
    expect(stages[2]?.after?.steps[0]).toMatchObject({
      kind: "gate",
      who: "Approvers",
      when: "touching ui",
    });
    expect(stages[1]?.does).toBe("Builder implements the spec.");
  });

  it("has tab titles", () => {
    expect(tabTitle("/factory/policy", () => null)).toBe("Policy");
    expect(tabTitle("/factory/workflows?workflow=Docs", () => null)).toBe("Workflows");
  });
});
