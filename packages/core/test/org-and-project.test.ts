// Review of #203: an operation whose input names both an org and a project (or a work item) must not
// let the narrower one decide the scope while the handler acts on the org: a member of org B could
// write into org A. Each such operation is pinned here with how it avoids that; a new one fails until
// it is reviewed.
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/registry.ts";

const REVIEWED: Record<string, string> = {
  "repository.list": "scoped by the org; the project is only a filter within it",
  "workItem.board": "scoped by the org; the project is only a filter within it",
  "workItem.list":
    "scoped by the project when given (the narrower one), and then never reads orgId",
  "autopilot.runNow": "scoped by the org; the handler refuses a project that isn't the org's",
  "autopilot.fire": "scoped by the org; the handler refuses a project that isn't the org's",
};

describe("operations that name an org and a project or item", () => {
  it("are each reviewed", () => {
    const both = OPERATIONS.filter((o) => {
      const shape = (o.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      return "orgId" in shape && ("projectId" in shape || "workItemId" in shape);
    })
      .map((o) => o.name)
      .sort();
    expect(both).toEqual(Object.keys(REVIEWED).sort());
  });
});
