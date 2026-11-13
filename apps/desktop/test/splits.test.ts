// Spec 24: how a split reads in the app: each child's size and order, the gate's label, and a list
// with children under their parent.
import { describe, expect, it } from "vitest";
import { releaseBlocker } from "../src/mainview/lib/backlog.ts";
import { groupUnderParents, splitApproveLabel, splitLines } from "../src/mainview/lib/splits.ts";

describe("splits in the app (spec 24)", () => {
  it("says each child's size and order, as PlanFocus does", () => {
    expect(
      splitLines([
        { key: "a", title: "Intake", size: "small" },
        { key: "b", title: "Report", size: "small", after: "a" },
        { key: "c", title: "Docs", size: "medium", after: "b" },
      ]).map((l) => l.detail),
    ).toEqual([
      "Small · builds first",
      "Small · waits for the first",
      "Medium · waits for “Report”",
    ]);
  });

  it("labels the gate with the work items it creates, and the .kim/ files", () => {
    expect(splitApproveLabel(0, 3)).toBeNull();
    expect(splitApproveLabel(2, undefined)).toBe("Approve the plan and 2 work items");
    expect(splitApproveLabel(1, 1)).toBe(
      "Approve the plan and 1 work item, writing 1 file to .kim/",
    );
  });

  it("puts children under their parent when the parent is listed, else keeps the order", () => {
    const items = [
      { id: "c1", parentWorkItemId: "p" },
      { id: "x" },
      { id: "p" },
      { id: "c2", parentWorkItemId: "p" },
      { id: "orphan", parentWorkItemId: "gone" },
    ];
    expect(groupUnderParents(items).map((r) => [r.item.id, r.depth])).toEqual([
      ["x", 0],
      ["p", 0],
      ["c1", 1],
      ["c2", 1],
      ["orphan", 0],
    ]);
  });

  it("says a held child waits for its plan instead of offering Release (review of #173)", () => {
    const project = {
      repositories: [{ id: "r" }],
      policy: { state: "valid" },
    } as unknown as Parameters<typeof releaseBlocker>[1];
    expect(
      releaseBlocker({ status: "ready", repositoryId: "r", heldForParent: true }, project),
    ).toBe("Held until the plan merges: it starts with its siblings");
    expect(releaseBlocker({ status: "ready", repositoryId: "r" }, project)).toBeNull();
  });
});
