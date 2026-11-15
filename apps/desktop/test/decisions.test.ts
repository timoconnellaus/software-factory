// The desktop's lists of operations that take a presence proof match core's operations (ADR 0381):
// an operation added to core that takes a desktop proof can't slip through `call`.
import { operations } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { DECIDE_OPS, DECISION_OPS } from "../src/shared/decisions.ts";

interface Op {
  name: string;
  browserOnly?: boolean;
  presenceSurfaces?: readonly string[];
}

const desktopProof = (Object.values(operations) as unknown[]).filter(
  (o): o is Op =>
    !!o && typeof o === "object" && ((o as Op).presenceSurfaces ?? []).includes("desktop"),
);

describe("presence decisions", () => {
  it("DECIDE_OPS is every operation that takes a desktop presence proof", () => {
    const names = desktopProof.map((o) => o.name).sort();
    expect(names.length).toBeGreaterThan(0);
    expect([...DECIDE_OPS].sort()).toEqual(names);
  });

  it("DECISION_OPS is those of them that are browser-only (never through call)", () => {
    const always = desktopProof
      .filter((o) => o.browserOnly === true)
      .map((o) => o.name)
      .sort();
    expect(always.length).toBeGreaterThan(0);
    expect([...DECISION_OPS].sort()).toEqual(always);
  });
});
