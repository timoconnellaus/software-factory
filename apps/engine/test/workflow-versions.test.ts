// Workflow versioning across deploys (ADR 0053). A running instance replays with new code and
// matches steps by name, so v1's step names are frozen: changing one means adding runV2.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isWaitTimeout, WORKFLOW_VERSION } from "../src/workflow/work-item.ts";
import { first, ok, waitFor, world } from "./helpers.ts";

// The step names v1 uses, as patterns. Each must still appear in the source: this list only grows.
const V1_STEPS = [
  "meta: version",
  "meta: item",
  "triage: enter",
  "branch: ensure",
  "triage: record",
  "spec: enter",
  "spec: commit",
  "build: enter",
  "end: done",
  "end: incident",
];

describe("Workflow versions", () => {
  it("starts new instances on version 1 and records it on the work item", async () => {
    expect(WORKFLOW_VERSION).toBe(1);
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Versioned" },
      w.human,
    );
    const row = await waitFor("the version recorded", () =>
      first<{ workflow_version: number }>(
        "SELECT workflow_version FROM core_work_items WHERE id = ? AND workflow_version IS NOT NULL",
        item.workItemId,
      ),
    );
    expect(row.workflow_version).toBe(1);
  });

  it("an instance whose recorded version has no implementation errors instead of running the wrong code", async () => {
    await using introspector = await introspectWorkflow(env.WORK_ITEM_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "meta: version" }, 99);
    });
    const w = await world();
    await ok("workItem.create", { projectId: w.projectId, title: "From the future" }, w.human);
    const [instance] = await waitFor("the instance", async () => {
      const list = await introspector.get();
      return list.length > 0 ? list : null;
    });
    await expect(instance?.waitForStatus("errored")).resolves.toBeUndefined();
  });

  it("only treats a real timeout as a timeout", () => {
    expect(
      isWaitTimeout(
        Object.assign(new Error("Execution timed out after 10ms"), {
          name: "WorkflowTimeoutError",
        }),
      ),
    ).toBe(true);
    expect(isWaitTimeout(new Error("Aborting engine: User called pause"))).toBe(false);
  });

  it("keeps v1's step names", async () => {
    const source = (await import("../src/workflow/work-item.ts?raw")).default as string;
    for (const name of V1_STEPS) expect(source, name).toContain(`"${name}"`);
  });
});
