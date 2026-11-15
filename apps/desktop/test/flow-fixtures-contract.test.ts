// The fixture door (screenshots/*-fixtures.ts) held to the flow contract: every answer it gives,
// to the inputs the app builds, parses against the same schemas the engine's real answers do
// (packages/client/src/flow-contract.ts; apps/engine/test/flow-contract.test.ts), so the screens'
// tests and screenshots never rest on a shape the server doesn't send.
import {
  type ContractIds,
  FLOW_OP_NAMES,
  FLOW_REQUESTS,
  FLOW_RESPONSES,
  type FlowOpName,
} from "@software-factory/client/flow-contract";
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import {
  API,
  CLIENT_ORG,
  FLOW_ITEMS,
  FLOW_ME,
  FLOW_ORG,
  RUN_VIEWS,
  SITE,
} from "../screenshots/flow-fixtures.ts";

const IDS: ContractIds = {
  orgId: FLOW_ORG,
  userId: FLOW_ME,
  projectId: API,
  workflowId: "fwf_ship",
  agentId: "fagt_backend",
  builderId: "fagt_chat",
  itemId: "fitm_rate",
  runId: "frun_fitm_rate",
  chatId: "fchat_launch",
  pluginName: "Slack updates",
  gatewayName: "Blog",
  gatewayId: "fgw_blog",
  scheduleId: "fsch_deps",
};

/** Each fixture's ids in turn: both orgs, every item, every run view, every chat. */
const VARIANTS: Partial<ContractIds>[] = [
  {},
  { orgId: CLIENT_ORG, projectId: SITE },
  ...FLOW_ITEMS.map((i) => ({ itemId: i.id, projectId: i.projectId })),
  ...Object.keys(RUN_VIEWS).map((runId) => ({ runId })),
  { chatId: "fchat_legal" },
];

/** Reads and writes first; what deletes runs last, so the reads see the whole fixture. */
const DELETES = new Set<FlowOpName>([
  "flow.chat.delete",
  "flow.plugin.delete",
  "flow.gateway.delete",
  "flow.schedule.delete",
]);
const ORDER = [
  ...FLOW_OP_NAMES.filter((op) => !DELETES.has(op)),
  ...FLOW_OP_NAMES.filter((op) => DELETES.has(op)),
];

describe("the fixture door's flow answers", () => {
  it("answers every operation the app calls", () => {
    expect(FLOW_OP_NAMES.filter((op) => !ANSWERS[op])).toEqual([]);
  });

  it.each(ORDER)("%s answers in the shape the server sends", (op) => {
    const answer = ANSWERS[op] as (input: unknown) => unknown;
    for (const variant of VARIANTS) {
      for (const input of FLOW_REQUESTS[op]({ ...IDS, ...variant })) {
        const out = answer(input);
        const parsed = FLOW_RESPONSES[op].safeParse(out);
        expect(
          parsed.success ? [] : parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
          `${op} ${JSON.stringify(input)}`,
        ).toEqual([]);
      }
    }
  });
});
