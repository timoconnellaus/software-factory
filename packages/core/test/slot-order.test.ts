// The order of judging steps within a slot is policy (review of #156): an agent check moved after
// the gate it ran before reaches the person unchecked, so the reorder loosens; two agent checks
// swapping ahead of the gate stays neutral. Pure: `policyImpact` over two parsed configs.
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";

const FLOOR = parseFloor(null);

function config(beforeVerify: Record<string, unknown>[]) {
  const parsed = parseProjectPolicy(
    JSON.stringify({
      version: 1,
      autonomyPolicy: "balanced",
      agents: [{ name: "Critic", role: "review", instructions: "" }],
      workflows: [
        { name: "Software", slots: { afterSpec: [], beforeVerify, afterVerify: [] }, core: {} },
      ],
      workflow: "Software",
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.policy;
}

const critic = { id: "critic", kind: "work", name: "Critic", agent: "Critic", instructions: "" };
const signOff = { id: "sign", kind: "gate", name: "Sign-off", instructions: "" };
const second = {
  id: "second",
  kind: "work",
  name: "Second look",
  agent: "Critic",
  instructions: "",
};

describe("the order of judging steps in a slot", () => {
  it("loosens when an agent check moves after the gate it ran before", () => {
    const impact = policyImpact(config([critic, signOff]), config([signOff, critic]), FLOOR);
    expect(impact.class).toBe("loosens");
    expect(impact.changes).toContainEqual(
      expect.objectContaining({
        class: "loosens",
        summary: "Software → Critic now runs after Sign-off (beforeVerify).",
      }),
    );
  });

  it("loosens the other way too: a gate moved ahead of a check decides before it", () => {
    const impact = policyImpact(config([signOff, critic]), config([critic, signOff]), FLOOR);
    expect(impact.class).toBe("loosens");
    expect(impact.changes.map((c) => c.summary)).toContain(
      "Software → Sign-off now runs after Critic (beforeVerify).",
    );
  });

  it("stays neutral when two agent checks swap, both still ahead of the gate", () => {
    const impact = policyImpact(
      config([critic, second, signOff]),
      config([second, critic, signOff]),
      FLOOR,
    );
    expect(impact.changes.filter((c) => c.class === "loosens")).toEqual([]);
  });
});
