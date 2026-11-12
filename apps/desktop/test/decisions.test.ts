// The desktop's list of gate decisions (they go through decide, never call) is exactly core's
// presence-decidable operations (ADR 0381): a decision added to core can't slip through `call`.
import { operations } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { DECISION_OPS } from "../src/shared/decisions.ts";

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
    expect([...DECISION_OPS].sort()).toEqual(decidable);
  });
});
