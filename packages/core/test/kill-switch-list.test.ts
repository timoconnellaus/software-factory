// killSwitch.list (ADR 0610): what the desktop shows before a person turns a switch off.
import { describe, expect, it } from "vitest";
import { ok, world } from "./helpers.ts";

type Listed = {
  org: { on: boolean } | null;
  projects: { projectId: string; on: boolean; reason: string | null }[];
};

describe("killSwitch.list", () => {
  it("lists the org's and its projects' switches", async () => {
    const w = await world();
    expect(await ok<Listed>("killSwitch.list", { orgId: w.orgId }, w.human)).toEqual({
      org: null,
      projects: [],
    });
    await ok(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: true, reason: "flaky deploys" },
      w.human,
    );
    const got = await ok<Listed>("killSwitch.list", { orgId: w.orgId }, w.human);
    expect(got.projects).toEqual([
      expect.objectContaining({ projectId: w.projectId, on: true, reason: "flaky deploys" }),
    ]);
  });
});
