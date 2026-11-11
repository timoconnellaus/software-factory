import { describe, expect, it } from "vitest";
import {
  ACTOR_TYPES,
  AUTONOMY_POLICIES,
  decide,
  parseFloor,
  parseProjectPolicy,
  RISK_CLASSES,
  specRequired,
} from "../src/index.ts";

const noFloor = parseFloor("");

describe("the gate check", () => {
  it("sends merge, deploy and self-modify to review for every actor and policy, even one that tries to allow them", () => {
    for (const risk of ["merge", "deploy", "self-modify"] as const) {
      for (const autonomyPolicy of AUTONOMY_POLICIES) {
        for (const actor of ACTOR_TYPES) {
          const loose = { [actor]: { [risk]: "allow" }, "*": { "*": "allow" } };
          const { decision } = decide({
            actor,
            risk,
            policy: { autonomyPolicy, overrides: loose },
            floor: noFloor,
          });
          // Never allowed. (Some actors are denied outright, which is stricter.)
          expect(decision, `${actor} ${risk} ${autonomyPolicy}`).not.toBe("allow");
          if (actor === "human" || actor === "agent") expect(decision).toBe("review");
        }
      }
    }
  });

  it("keeps the spec gate (plan) for agents under every shipped policy", () => {
    for (const autonomyPolicy of AUTONOMY_POLICIES) {
      expect(decide({ actor: "agent", risk: "plan", policy: { autonomyPolicy, overrides: {} }, floor: noFloor }).decision).toBe(
        "review",
      );
    }
  });

  it("fails closed: no policy denies non-humans, a malformed floor denies everyone", () => {
    expect(decide({ actor: "agent", risk: "read", policy: null, floor: noFloor }).decision).toBe("deny");
    expect(decide({ actor: "human", risk: "write", policy: null, floor: noFloor }).decision).toBe("allow");
    const bad = parseFloor("{ not json");
    expect(bad.ok).toBe(false);
    for (const actor of ACTOR_TYPES) {
      expect(decide({ actor, risk: "read", policy: { autonomyPolicy: "autonomous", overrides: {} }, floor: bad }).decision).toBe(
        "deny",
      );
    }
    expect(parseFloor('{"agent":{"write":"maybe"}}').ok).toBe(false);
    expect(parseFloor('{"robot":{"write":"deny"}}').ok).toBe(false);
  });

  it("lets the floor only tighten", () => {
    const floor = parseFloor('{"agent":{"write":"review"},"*":{"read":"allow"}}');
    const balanced = { autonomyPolicy: "balanced" as const, overrides: {} };
    expect(decide({ actor: "agent", risk: "write", policy: balanced, floor }).decision).toBe("review");
    expect(decide({ actor: "intake", risk: "plan", policy: balanced, floor }).decision).toBe("deny");
    for (const risk of RISK_CLASSES) {
      const without = decide({ actor: "runner", risk, policy: balanced, floor: noFloor }).decision;
      const withFloor = decide({ actor: "runner", risk, policy: balanced, floor }).decision;
      const rank = { allow: 0, review: 1, deny: 2 };
      expect(rank[withFloor]).toBeGreaterThanOrEqual(rank[without]);
    }
  });
});

describe("project policy", () => {
  it("parses a valid policy with defaults and rejects unknown keys and bad overrides", () => {
    const ok = parseProjectPolicy('{"version":1,"autonomyPolicy":"balanced"}');
    expect(ok.ok && ok.policy.spec.requiredFrom).toBe("medium");
    expect(parseProjectPolicy('{"version":1,"autonomyPolicy":"yolo"}').ok).toBe(false);
    expect(parseProjectPolicy('{"version":1,"autonomyPolicy":"balanced","extra":1}').ok).toBe(false);
    expect(
      parseProjectPolicy('{"version":1,"autonomyPolicy":"balanced","overrides":{"agent":{"merge":"sometimes"}}}').ok,
    ).toBe(false);
    expect(parseProjectPolicy("nope").ok).toBe(false);
  });

  it("decides the spec gate in code: the foreman can add a spec but never skip a required one", () => {
    const policy = { spec: { requiredFrom: "medium" as const } };
    expect(specRequired(policy, "small").required).toBe(false);
    expect(specRequired(policy, "small", "require").required).toBe(true);
    expect(specRequired(policy, "medium", "skip")).toMatchObject({ required: true });
    expect(specRequired(policy, "medium", "skip").reason).toMatch(/asked to skip/);
    expect(specRequired({ spec: { requiredFrom: "large" } }, "large", "skip").required).toBe(true);
  });
});
