// The app's half of the flow contract, with no database: every operation the desktop app calls is
// in the server's registry, and every input the app builds parses against that operation's zod
// schema with nothing dropped (a field the server doesn't take is a field silently ignored).
// The answers are checked against the real engine in apps/engine/test/flow-contract.test.ts.
import { getOperation, describe as listOperations } from "@software-factory/ops";
import { describe, expect, it } from "vitest";
import {
  type ContractIds,
  droppedKeys,
  FLOW_OP_NAMES,
  FLOW_REQUESTS,
} from "../src/flow-contract.ts";

const IDS: ContractIds = {
  orgId: "org_1",
  userId: "usr_1",
  projectId: "fprj_1",
  workflowId: "fwf_1",
  agentId: "fagt_1",
  itemId: "fitm_1",
  runId: "frun_1",
  chatId: "fchat_1",
  pluginName: "cards",
  gatewayName: "blog",
  gatewayId: "fgw_1",
  scheduleId: "fsch_1",
  repoOwner: "acme",
  repoName: "api",
};

describe("the app's flow operations against the server's registry", () => {
  it("names only operations the server has", () => {
    const registry = new Set(listOperations().map((o) => o.name));
    expect(FLOW_OP_NAMES.filter((name) => !registry.has(name))).toEqual([]);
  });

  it.each(FLOW_OP_NAMES)("%s: every input the app builds parses, and keeps every field", (name) => {
    const op = getOperation(name);
    if (!op) throw new Error(`no operation ${name}`);
    const inputs = FLOW_REQUESTS[name](IDS);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      const parsed = op.input.safeParse(input);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        JSON.stringify(input),
      ).toEqual([]);
      expect(droppedKeys(input, parsed.data), JSON.stringify(input)).toEqual([]);
    }
  });
});
