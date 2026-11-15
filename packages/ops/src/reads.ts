// The views: a project's board, an item's timeline and runs, an agent's runs, a person's inbox (in
// one org, or across all of theirs), and an org's members.
import {
  AGENT_RUNS_LIMIT,
  agentRuns,
  board,
  declaredFields,
  getListedRun,
  INBOX_ALL_LIMIT,
  INBOX_ALL_ORGS,
  inbox,
  inboxAll,
  itemRuns,
  listMembers,
  MEMBER_LIMIT,
  timeline,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, defineSelfOperation, id, OpError, orgId, personOf } from "./operation.ts";

export const readOps = [
  defineOperation({
    name: "flow.board.get",
    description:
      "A project's board: one column per status in workflow order, each with its items (and each item's fields, projectName, projectKey and statusName). `declaredFields` are the fields the org's plugins add, to show on the cards. At most 500 items; `truncated` says some were left out.",
    risk: "read",
    input: z.object({ orgId, projectId: id }),
    handler: async (input, ctx) => {
      const [view, fields] = await Promise.all([
        board(ctx.d1, input.projectId),
        declaredFields(ctx.d1, ctx.orgId),
      ]);
      return { ...view, declaredFields: fields };
    },
  }),
  defineOperation({
    name: "flow.timeline.get",
    description:
      "An item's timeline, oldest first: each event, what it caused (moves, runs queued, inbox entries), comments (an agent's summary carries its `runId`, as does the run.ended event) and plugins' cards (kind `card`: { kind, title, subtitle?, rows?, checks?, bars?, link? }). The newest 500; `truncated` says older ones were left out.",
    risk: "read",
    input: z.object({ orgId, itemId: id }),
    handler: (input, ctx) => timeline(ctx.d1, input.itemId),
  }),
  defineOperation({
    name: "flow.inbox.get",
    description:
      "What waits on you in this org: items in statuses you own (`work`) and items waiting on a decision (`decisions`), each with projectName, projectKey and statusName. At most 100 of each.",
    risk: "read",
    input: z.object({ orgId }),
    handler: (_input, ctx) => inbox(ctx.d1, ctx.orgId, personOf(ctx.actor)),
  }),
  defineSelfOperation({
    name: "flow.inbox.all",
    description: `What waits on you in every org you are a member of (at most ${INBOX_ALL_ORGS}, by name): per org, items in statuses you own (\`work\`), items waiting on a decision (\`decisions\`) and items waiting on an agent's run (\`working\`), each with projectName, projectKey and statusName. At most ${INBOX_ALL_LIMIT} of each, oldest first. Takes no orgId.`,
    risk: "read",
    input: z.object({}),
    handler: async (_input, ctx) => ({ orgs: await inboxAll(ctx.d1, ctx.actor.id) }),
  }),
  defineOperation({
    name: "flow.member.list",
    description: `The org's members by name: each one's userId (what a person owner names), name and GitHub login (or null). At most ${MEMBER_LIMIT}.`,
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ members: await listMembers(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.run.list",
    description: `Runs, each with its agent, status, result or error, and its item's itemTitle, itemNumber and projectKey (a chat's run has its chatId and chatTitle instead, with the item's fields null). Either { itemId }: the item's runs, by stay; or { agentId, limit? }: the agent's newest runs first (limit default 20, at most ${AGENT_RUNS_LIMIT}).`,
    risk: "read",
    input: z.union([
      z.object({ orgId, itemId: id }),
      z.object({
        orgId,
        agentId: id,
        limit: z.number().int().min(1).max(AGENT_RUNS_LIMIT).default(20),
      }),
    ]),
    handler: async (input, ctx) => ({
      runs:
        "itemId" in input
          ? await itemRuns(ctx.d1, input.itemId)
          : await agentRuns(ctx.d1, ctx.orgId, input.agentId, input.limit),
    }),
  }),
  defineOperation({
    name: "flow.run.get",
    description:
      "One run: its agent, status, brief, result or error, and its item's itemTitle, itemNumber and projectKey (or, for a chat's run, its chatId and chatTitle).",
    risk: "read",
    input: z.object({ orgId, runId: id }),
    handler: async (input, ctx) => {
      const run = await getListedRun(ctx.d1, input.runId);
      if (!run) throw new OpError("not_found", `No run ${input.runId}.`);
      return { run };
    },
  }),
];
