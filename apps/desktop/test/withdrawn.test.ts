// The reopened merge gate says plainly that an approval was withdrawn, and why (#61).
import { describe, expect, it } from "vitest";
import { withdrawnBefore, withdrawnText } from "../src/mainview/lib/withdrawn.ts";

const gate = (g: Partial<Parameters<typeof withdrawnBefore>[0][number]>) => ({
  kind: "merge",
  status: "pending",
  decision: null,
  createdAt: "2026-11-13T06:10:00.000Z",
  decidedAt: null,
  note: null,
  ...g,
});

describe("withdrawnBefore", () => {
  it("names the withdrawal before the open merge gate, and why", () => {
    const w = withdrawnBefore([
      gate({
        status: "rejected",
        decision: "withdrawn",
        createdAt: "2026-11-13T05:00:00.000Z",
        decidedAt: "2026-11-13T06:00:00.000Z",
        note: "withdrawn: the approval was withdrawn when main was merged in: it changed files",
      }),
      gate({}),
    ]);
    expect(w).toEqual({
      at: "2026-11-13T06:00:00.000Z",
      reason: "the approval was withdrawn when main was merged in: it changed files",
    });
    expect(withdrawnText(w as NonNullable<typeof w>, () => "10m ago")).toBe(
      "Your approval was withdrawn 10m ago because the approval was withdrawn when main was merged in: it changed files; it has been verified again.",
    );
  });

  it("says nothing when the last decision wasn't a withdrawal, or no gate is open", () => {
    expect(
      withdrawnBefore([
        gate({ status: "approved", decision: "approved", decidedAt: "2026-11-13T06:00:00.000Z" }),
        gate({}),
      ]),
    ).toBeNull();
    expect(
      withdrawnBefore([
        gate({ status: "rejected", decision: "withdrawn", decidedAt: "2026-11-13T06:00:00.000Z" }),
      ]),
    ).toBeNull();
  });
});
