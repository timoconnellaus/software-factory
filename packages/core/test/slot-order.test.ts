// The order of judging steps within a slot is policy (review of #156): an agent check moved after
// the gate it ran before reaches the person unchecked, so the reorder loosens; and any other reversed
// pair in a slot loosens too (fail-closed, review of #161): a work step can ask a person or send back,
// so even two agent checks swapping isn't provably inert.
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";
import { call, ok, POLICY, world } from "./helpers.ts";

const FLOOR = parseFloor(null);

function doc(beforeVerify: Record<string, unknown>[], active = "Software") {
  return {
    version: 1,
    autonomyPolicy: "balanced",
    agents: [{ name: "Critic", role: "review", instructions: "" }],
    workflows: [
      { name: "Software", slots: { afterSpec: [], beforeVerify, afterVerify: [] }, core: {} },
      { name: "Other", slots: { afterSpec: [], beforeVerify: [], afterVerify: [] }, core: {} },
    ],
    workflow: active,
  };
}

function config(beforeVerify: Record<string, unknown>[], active = "Software") {
  const parsed = parseProjectPolicy(JSON.stringify(doc(beforeVerify, active)));
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

  it("loosens when two agent checks swap, even both still ahead of the gate", () => {
    const impact = policyImpact(
      config([critic, second, signOff]),
      config([second, critic, signOff]),
      FLOOR,
    );
    expect(impact.class).toBe("loosens");
    expect(impact.changes.map((c) => c.summary)).toContain(
      "Software → Critic now runs after Second look (beforeVerify).",
    );
  });

  it("loosens a three-step rotation, every reversed pair reported", () => {
    const impact = policyImpact(
      config([critic, second, signOff]),
      config([signOff, critic, second]),
      FLOOR,
    );
    expect(impact.class).toBe("loosens");
    expect(impact.changes.filter((c) => c.class === "loosens")).toHaveLength(2);
  });

  it("loosens in a workflow the project doesn't run now, too", () => {
    const impact = policyImpact(
      config([critic, second], "Other"),
      config([second, critic], "Other"),
      FLOOR,
    );
    expect(impact.class).toBe("loosens");
  });

  it("a config save that reorders a slot waits for an approver", async () => {
    const w = await world({ ...POLICY, ...doc([critic, second, signOff]) });
    const got = await ok<{ current: { version: number } | null }>(
      "config.get",
      { projectId: w.projectId },
      w.human,
    );
    const saved = await call<{ impact: { class: string } }>(
      "config.save",
      {
        projectId: w.projectId,
        baseVersion: got.current?.version ?? 0,
        policy: { ...POLICY, ...doc([second, critic, signOff]) },
      },
      w.human,
    );
    expect(saved.status).toBe("pending");
  });
});
