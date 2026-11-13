// The desktop's list of gate decisions (they go through decide, never call) is exactly core's
// presence-decidable operations (ADR 0381): a decision added to core can't slip through `call`.
import { operations } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { DECIDE_OPS, DECISION_OPS } from "../src/shared/decisions.ts";

describe("gate decisions", () => {
  it("match core's presence-decidable operations", () => {
    const decidable = (Object.values(operations) as unknown[])
      .filter(
        (o): o is { name: string; presenceDecidable: true } =>
          !!o &&
          typeof o === "object" &&
          (o as { presenceDecidable?: boolean }).presenceDecidable === true,
      )
      .map((o) => o.name)
      .sort();
    expect(decidable.length).toBeGreaterThan(0);
    // Everything presence-decidable may go through decide…
    expect([...DECIDE_OPS].sort()).toEqual(decidable);
    // …and only what always needs a proof is refused through call: a desktopDecidable operation
    // (planning answers, spec 26) asks for one only for some inputs.
    const always = (Object.values(operations) as unknown[])
      .filter(
        (o): o is { name: string } =>
          !!o &&
          typeof o === "object" &&
          (o as { presenceDecidable?: boolean }).presenceDecidable === true &&
          (o as { desktopDecidable?: boolean }).desktopDecidable !== true &&
          // A proof for some inputs only: the rest go through call.
          typeof (o as { browserOnly?: unknown }).browserOnly !== "function" &&
          typeof (o as { desktopOneTap?: unknown }).desktopOneTap !== "function",
      )
      .map((o) => o.name)
      .sort();
    expect([...DECISION_OPS].sort()).toEqual(always);
  });
});
