// The views: a project's board, an item's timeline and runs, and a person's inbox.
import { board, inbox, itemRuns, timeline } from "@software-factory/store";
import { z } from "zod";
import { defineOperation, id, orgId } from "./operation.ts";

export const readOps = [
  defineOperation({
    name: "flow.board.get",
    description:
      "A project's board: one column per status in workflow order, each with its items. At most 500 items; `truncated` says some were left out.",
    risk: "read",
    input: z.object({ orgId, projectId: id }),
    handler: (input, ctx) => board(ctx.d1, input.projectId),
  }),
  defineOperation({
    name: "flow.timeline.get",
    description:
      "An item's timeline, oldest first: each event, what it caused (moves, runs queued, inbox entries) and comments, including an agent's summary. The newest 500; `truncated` says older ones were left out.",
    risk: "read",
    input: z.object({ orgId, itemId: id }),
    handler: (input, ctx) => timeline(ctx.d1, input.itemId),
  }),
  defineOperation({
    name: "flow.inbox.get",
    description:
      "What waits on you in this org: items in statuses you own (`work`) and items waiting on a decision (`decisions`). At most 100 of each.",
    risk: "read",
    input: z.object({ orgId }),
    handler: (_input, ctx) => inbox(ctx.d1, ctx.orgId, ctx.actor.id),
  }),
  defineOperation({
    name: "flow.run.list",
    description: "An item's runs, by stay: each with its agent, status, result or error.",
    risk: "read",
    input: z.object({ orgId, itemId: id }),
    handler: async (input, ctx) => ({ runs: await itemRuns(ctx.d1, input.itemId) }),
  }),
];
