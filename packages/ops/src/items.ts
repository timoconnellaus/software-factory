// flow.item.*: create an item, and the kernel's events a person (or an agent through the MCP
// server) sends it (move, finish, decide, retry), comments and fields. Every event goes through the
// plugin host's applyItemEvent, so the org's plugins' hooks run around it.
import type { ItemEvent } from "@software-factory/flow";
import { applyItemEvent, createItemWithHooks } from "@software-factory/plugins";
import { addComment, declaredFields, getItem, setField } from "@software-factory/store";
import { z } from "zod";
import {
  type Ctx,
  defineOperation,
  id,
  kernelActor,
  OpError,
  orgId,
  personOf,
} from "./operation.ts";

const item = { orgId, itemId: id };

/** Applies the caller's event to the item; the kernel refuses one that doesn't fit its state. */
const send = (ctx: Ctx, itemId: string, event: ItemEvent) =>
  applyItemEvent(ctx.host, itemId, event, kernelActor(ctx.actor));

export const itemOps = [
  defineOperation({
    name: "flow.item.create",
    description:
      "Create an item in a project. It enters the workflow's first status and goes to that status's owner: an agent's run is queued, or it shows in a person's inbox. The org's plugins' `entered` hooks run.",
    risk: "write",
    input: z.object({
      orgId,
      projectId: id,
      title: z.string().min(1).max(300),
      body: z.string().max(100_000).default(""),
    }),
    handler: (input, ctx) =>
      createItemWithHooks(ctx.host, {
        orgId: ctx.orgId,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        createdBy: personOf(ctx.actor),
        actor: kernelActor(ctx.actor),
      }),
  }),
  defineOperation({
    name: "flow.item.get",
    description:
      "One item: its status, what it waits on, any error, and its fields; `declaredFields` are the fields the org's plugins add to items.",
    risk: "read",
    input: z.object(item),
    handler: async (input, ctx) => {
      const [found, fields] = await Promise.all([
        getItem(ctx.d1, input.itemId),
        declaredFields(ctx.d1, ctx.orgId),
      ]);
      if (!found) throw new OpError("not_found", `No item ${input.itemId}.`);
      return { ...found, declaredFields: fields };
    },
  }),
  defineOperation({
    name: "flow.item.move",
    description:
      "Move an item to a status by hand. Its open run is cancelled and the new status's owner gets it. A plugin's `leaving` hook may refuse the move, with its reason.",
    risk: "write",
    input: z.object({ ...item, to: z.string().min(1) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, { type: "moved", by: kernelActor(ctx.actor), to: input.to }),
  }),
  defineOperation({
    name: "flow.item.finish",
    description:
      "The person who owns the item's status finishes the work: done moves it on, rejected sends it back.",
    risk: "write",
    input: z.object({ ...item, outcome: z.enum(["done", "rejected"]) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, {
        type: "person.finished",
        by: kernelActor(ctx.actor),
        outcome: input.outcome,
      }),
  }),
  defineOperation({
    name: "flow.item.decide",
    description:
      "Decide on an item waiting for a person's decision: approve moves it on, reject sends it back.",
    risk: "write",
    input: z.object({ ...item, decision: z.enum(["approve", "reject"]) }),
    handler: (input, ctx) =>
      send(ctx, input.itemId, {
        type: "decided",
        by: kernelActor(ctx.actor),
        decision: input.decision,
      }),
  }),
  defineOperation({
    name: "flow.item.retry",
    description:
      "Try the item's status again after a run or a plugin failed there. The status's `entered` hooks run again.",
    risk: "write",
    input: z.object(item),
    handler: (input, ctx) =>
      send(ctx, input.itemId, { type: "retried", by: kernelActor(ctx.actor) }),
  }),
  defineOperation({
    name: "flow.item.comment",
    description:
      "Add a comment to the item's timeline. The next run on the item reads recent comments.",
    risk: "write",
    input: z.object({ ...item, text: z.string().min(1).max(20_000) }),
    handler: async (input, ctx) => {
      await addComment(ctx.d1, input.itemId, kernelActor(ctx.actor), input.text);
      return { ok: true };
    },
  }),
  defineOperation({
    name: "flow.item.setField",
    description:
      "Set one of the item's fields (the org's plugins declare them: see flow.item.get's declaredFields). A value of null clears it.",
    risk: "write",
    input: z.object({
      ...item,
      fieldId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      value: z.union([z.string().max(10_000), z.number(), z.null()]),
    }),
    handler: async (input, ctx) => {
      await setField(ctx.d1, input.itemId, input.fieldId, input.value);
      return getItem(ctx.d1, input.itemId);
    },
  }),
];
