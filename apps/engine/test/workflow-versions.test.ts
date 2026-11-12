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
// The steps v2 adds (V1 step 4): the early PR, the CI wait and the incident auto-merge. Written with
// `{x}` for the template's `${x}`.
const V2_STEPS = [
  "verify #{b}: open PR",
  "verify #{b}: ci{sfx}",
  "verify #{b}: ci wait{sfx}",
  "merge #{b}: auto-merge",
].map((name) => `\`${name.replaceAll("{", "$" + "{")}\``);
// The steps v3 adds (ADR 0320): the mergeability reads, the conflict send-back, the no-CI question.
const V3_STEPS = [
  "verify #{b}: mergeable{sfx}",
  "verify #{b}: mergeable wait{sfx}",
  "build #{b}: conflict",
  "verify #{b}: no ci",
].map((name) => `${name.replaceAll("{", "$" + "{")}`);

// The steps v4 adds (ADR 0330): the merge queue. `{p}` is `merge #{b}: <queue|auto-merge|…>`.
const V4_STEPS = [
  "{p}: enqueue",
  "{p}: position{sfx}",
  "{p}: turn{sfx}",
  "{p}: update{sfx}",
  "{p}: update wait{sfx}",
  "{p}: land",
  "{p}: leave",
  "merge #{b}: {tag}",
].map((name) => `${name.replaceAll("{", "$" + "{")}`);
// The steps v5 adds (spec 20): the planning session instead of the spec rounds.
const V5_STEPS = [
  '"planning: start"',
  ...[
    "planning #{k}: await",
    "planning #{k}: ready{sfx}",
    "planning #{k}: escalate{sfx}",
    "planning #{k}: gate",
    "planning #{k}: end",
    "planning #{k}: note",
    "planning #{k}: criteria",
  ].map((name) => `\`${name.replaceAll("{", "$" + "{")}\``),
];
// The steps v6 adds (spec 09 M2, ADR 0371): the workflow's options and plan, and the slot steps.
const V6_STEPS = [
  '"workflow: options"',
  '"workflow: plan"',
  "`slot:${slot}:${round}:${i}:${s.id}`",
  "`${name}: record`",
  "`${name}: ask`",
];
// The steps v8 adds (spec 51, ADR 0501): the factory's checks on the build's head, the question when
// they still fail, and the attached PR's check names for its reviewer.
const V8_STEPS = [
  "build #{b}: checks",
  "build #{b}: checks failed",
  "verify #{b}: check names",
  "build #{b}: checks failing",
].map((name) => `\`${name.replaceAll("{", "$" + "{")}\``);
// The tags v4 builds `{p}` from: frozen like the step names.
const V4_TAGS = ['"queue"', '"auto-merge"', '"auto-merge landing"'];

describe("Workflow versions", () => {
  it("starts new instances on version 8 and records it on the work item", async () => {
    expect(WORKFLOW_VERSION).toBe(8);
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
    expect(row.workflow_version).toBe(8);
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
    for (const name of V2_STEPS) expect(source, name).toContain(name);
    for (const name of V3_STEPS) expect(source, name).toContain(name);
    for (const name of [...V4_STEPS, ...V4_TAGS]) expect(source, name).toContain(name);
    for (const name of V5_STEPS) expect(source, name).toContain(name);
    for (const name of V6_STEPS) expect(source, name).toContain(name);
    for (const name of V8_STEPS) expect(source, name).toContain(name);
    // v5 instances still dispatch to the same flow, with v6's workflow slots switched off.
    expect(source).toContain("return flow.runV1(5);");
    // v4 instances still dispatch to the same flow, with v5's planning session switched off.
    expect(source).toContain("return flow.runV1(4);");
    // v3 instances still dispatch to the same flow, with v4's merge queue switched off.
    expect(source).toContain("return flow.runV1(3);");
    // v2 instances still dispatch to the same flow, with v3's extra steps switched off.
    expect(source).toContain("return flow.runV1(2);");
    // v1 instances still dispatch to the same flow, with v2's extra steps switched off.
    expect(source).toContain("return flow.runV1(1);");
  });
});
