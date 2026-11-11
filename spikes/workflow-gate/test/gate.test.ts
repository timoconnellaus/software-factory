import { describe, expect, it } from "vitest";
import {
  ACTOR_TYPES,
  ALWAYS_REVIEW,
  decide,
  PRESETS,
  parseFloor,
  parsePreset,
  RISK_CLASSES,
} from "../src/ops/gate";

const noFloor = parseFloor("");

describe("gate: presets", () => {
  it("lets humans do anything in every preset", () => {
    for (const preset of PRESETS) {
      for (const risk of RISK_CLASSES) {
        expect(decide({ actor: "human", risk, preset, floor: noFloor }).decision).toBe("auto");
      }
    }
  });

  it("never auto-approves merge, deploy or self-modify for a non-human actor", () => {
    for (const preset of PRESETS) {
      for (const actor of ACTOR_TYPES.filter((a) => a !== "human")) {
        for (const risk of ALWAYS_REVIEW) {
          expect(decide({ actor, risk, preset, floor: noFloor }).decision).not.toBe("auto");
        }
      }
    }
  });

  it.each([
    ["cautious", "write", "review"],
    ["balanced", "write", "auto"],
    ["balanced", "plan", "review"],
    ["autonomous", "plan", "auto"],
    ["autonomous", "outbound", "auto"],
    ["autonomous", "merge", "review"],
  ] as const)("agent in %s: %s → %s", (preset, risk, expected) => {
    expect(decide({ actor: "agent", risk, preset, floor: noFloor }).decision).toBe(expected);
  });

  it("denies intake anything but reads and writes", () => {
    expect(
      decide({ actor: "intake", risk: "write", preset: "autonomous", floor: noFloor }).decision,
    ).toBe("auto");
    expect(
      decide({ actor: "intake", risk: "merge", preset: "autonomous", floor: noFloor }).decision,
    ).toBe("deny");
  });

  it("treats an unknown preset as cautious", () => {
    expect(parsePreset("yolo")).toBe("cautious");
    expect(parsePreset(null)).toBe("cautious");
    expect(parsePreset("balanced")).toBe("balanced");
  });
});

describe("gate: the floor", () => {
  it("clamps a preset: Autonomous agent outbound becomes review", () => {
    const floor = parseFloor(JSON.stringify({ agent: { outbound: "review" } }));
    expect(decide({ actor: "agent", risk: "outbound", preset: "autonomous", floor })).toEqual({
      decision: "review",
      reason: "floor",
    });
  });

  it("applies wildcard rules, and the strictest matching rule wins", () => {
    const floor = parseFloor(JSON.stringify({ "*": { spend: "review" }, agent: { "*": "deny" } }));
    expect(decide({ actor: "agent", risk: "write", preset: "autonomous", floor }).decision).toBe(
      "deny",
    );
    expect(decide({ actor: "runner", risk: "spend", preset: "autonomous", floor }).decision).toBe(
      "review",
    );
    // The floor applies to humans too.
    expect(decide({ actor: "human", risk: "spend", preset: "autonomous", floor }).decision).toBe(
      "review",
    );
  });

  it("can only tighten: an `auto` floor rule never loosens the preset", () => {
    const floor = parseFloor(JSON.stringify({ agent: { merge: "auto", write: "auto" } }));
    expect(decide({ actor: "agent", risk: "merge", preset: "autonomous", floor }).decision).toBe(
      "review",
    );
    expect(decide({ actor: "agent", risk: "write", preset: "cautious", floor }).decision).toBe(
      "review",
    );
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an unknown actor", JSON.stringify({ robot: { write: "auto" } })],
    ["an unknown risk", JSON.stringify({ agent: { launch: "deny" } })],
    ["an unknown decision", JSON.stringify({ agent: { write: "maybe" } })],
  ])("fails closed when the floor is %s", (_label, raw) => {
    const floor = parseFloor(raw);
    expect(floor.ok).toBe(false);
    for (const actor of ACTOR_TYPES) {
      expect(decide({ actor, risk: "read", preset: "autonomous", floor }).decision).toBe("deny");
    }
  });
});
