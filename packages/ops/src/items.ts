// flow.item.*: create an item, and the kernel's events a person sends it (move, finish, decide,
// retry), and comments.
import type { ItemEvent } from "@software-factory/flow";
import { addComment, applyEvent, createItem, getItem } from "@software-factory/store";
import { z } from "zod";
import { type Ctx, defineOperation, id, OpError, orgId } from "./operation.ts";

const item = { orgId, itemId: id };

/** Applies a person's event to the item; the kernel refuses one that doesn't fit its state. */
const send = (ctx: Ctx, itemId: string, event: ItemEvent) =>
  applyEvent(ctx.d1, itemId, event, ctx.actor);

export const itemOps = [
  defineOperation({
    name: "flow.item.create",
    description:
      "Create an item in a project. It enters the workflow's first status and goes to that status's owner: an agent's run is queued, or it shows in a person's inbox.",
    risk: "write",
    input: z.object({
      orgId,
      projectId: id,
      title: z.string().min(1).max(300),
      body: z.string().max(100_000).default(""),
    }),
    handler: (input, ctx) =>
      createItem(ctx.d1, {
        orgId: ctx.orgId,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        createdBy: ctx.actor.id,
      }),
  }),
  defineOperation({
    name: "flow.item.get",
    description: "One item: its status, what it waits on, and any error.",
    risk: "read",
    input: z.object(item),
    handler: async (input, ctx) => {
      const found = await getItem(ctx.d1, input.itemId);
      if (!found) throw new OpError("not_found", `No item ${input.itemId}.`);
      return found;
    },
  }),
  defineOperation({
    name: "flow.item.move",
    description:
      "Move an item to a status by hand. Its open run is cancelled and the new status's owner gets it.",
    risk: "write",
    input: z.object({ ...item, to: z.string().min(1) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, { type: "moved", by: ctx.actor, to: input.to }),
  }),
  defineOperation({
    name: "flow.item.finish",
    description:
      "The person who owns the item's status finishes the work: done moves it on, rejected sends it back.",
    risk: "write",
    input: z.object({ ...item, outcome: z.enum(["done", "rejected"]) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, { type: "person.finished", by: ctx.actor, outcome: input.outcome }),
  }),
  defineOperation({
    name: "flow.item.decide",
    description:
      "Decide on an item waiting for a person's decision: approve moves it on, reject sends it back.",
    risk: "write",
    input: z.object({ ...item, decision: z.enum(["approve", "reject"]) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, { type: "decided", by: ctx.actor, decision: input.decision }),
  }),
  defineOperation({
    name: "flow.item.retry",
    description: "Try the item's status again after a run failed there.",
    risk: "write",
    input: z.object(item),
    handler: (input, ctx) => send(ctx, input.itemId, { type: "retried", by: ctx.actor }),
  }),
  defineOperation({
    name: "flow.item.comment",
    description:
      "Add a comment to the item's timeline. The next run on the item reads recent comments.",
    risk: "write",
    input: z.object({ ...item, text: z.string().min(1).max(20_000) }),
    handler: async (input, ctx) => {
      await addComment(ctx.d1, input.itemId, ctx.actor, input.text);
      return { ok: true };
    },
  }),
];
