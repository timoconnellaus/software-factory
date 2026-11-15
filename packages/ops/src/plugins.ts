// flow.plugin.* and flow.gateway.*: an org's plugins (code that changes how the org works, live
// at once) and its gateways (connections to outside systems, used by plugins by name). No approval
// of edits and no limits (ADR 0660): saving a plugin that loads is enough.
import { savePluginChecked } from "@software-factory/plugins";
import {
  deleteGateway,
  deletePlugin,
  getPlugin,
  listGateways,
  listPlugins,
  type Plugin,
  saveGateway,
  setPluginEnabled,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, OpError, orgId, personOf } from "./operation.ts";

const name = z.string().trim().min(1).max(64);

/** Where a plugin's trigger is posted, relative to the engine. */
export const triggerPath = (p: Plugin) =>
  `/flow/triggers/${p.id}/<name>?key=${encodeURIComponent(p.triggerKey)}`;

/** A plugin as a list shows it: no code; its trigger path (with its key) if it defines a trigger. */
const summary = (p: Plugin) => ({
  id: p.id,
  name: p.name,
  request: p.request,
  enabled: p.enabled,
  lastError: p.lastError,
  fields: p.fields,
  hooks: p.hooks,
  createdBy: p.createdBy,
  updatedAt: p.updatedAt,
  ...(p.hooks.includes("trigger") ? { triggerPath: triggerPath(p) } : {}),
});

const full = (p: Plugin) => ({ ...summary(p), code: p.code, triggerPath: triggerPath(p) });

export const pluginOps = [
  defineOperation({
    name: "flow.plugin.list",
    description:
      "The org's plugins by name: each one's request (the person's plain words), whether it is on, its last error, and the fields and hooks it declares; one that defines a trigger has its triggerPath (POST it with a JSON body). No code.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({
      plugins: (await listPlugins(ctx.d1, ctx.orgId)).map(summary),
    }),
  }),
  defineOperation({
    name: "flow.plugin.get",
    description:
      "One plugin by name, with its code and its trigger path (POST it with a JSON body to call the plugin's on.trigger).",
    risk: "read",
    input: z.object({ orgId, name }),
    handler: async (input, ctx) => {
      const found = await getPlugin(ctx.d1, ctx.orgId, input.name);
      if (!found) throw new OpError("not_found", `No plugin "${input.name}".`);
      return full(found);
    },
  }),
  defineOperation({
    name: "flow.plugin.save",
    description:
      "Create the plugin `name`, or replace its code: one ES module whose default export is { fields?, on? } (plugin_guide on the MCP server explains it). Saved only if it loads and has that shape; otherwise refused with the error. Live at once for every item in the org.",
    risk: "write",
    input: z.object({
      orgId,
      name,
      request: z.string().max(20_000).default(""),
      code: z.string().min(1).max(1_000_000),
    }),
    handler: async (input, ctx) => {
      const saved = await savePluginChecked(ctx.host, {
        orgId: ctx.orgId,
        name: input.name,
        request: input.request,
        code: input.code,
        createdBy: personOf(ctx.actor),
      });
      if (!saved.ok) {
        throw new OpError("invalid_input", `The plugin didn't load: ${saved.error}`, {
          loadError: saved.error,
        });
      }
      return full(saved.plugin);
    },
  }),
  defineOperation({
    name: "flow.plugin.delete",
    description: "Delete the plugin `name`. Its fields' values stay on items but aren't shown.",
    risk: "write",
    input: z.object({ orgId, name }),
    handler: async (input, ctx) => {
      await deletePlugin(ctx.d1, ctx.orgId, input.name);
      return { ok: true };
    },
  }),
  defineOperation({
    name: "flow.plugin.setEnabled",
    description: "Turn the plugin `name` on or off. An off plugin's hooks and trigger don't run.",
    risk: "write",
    input: z.object({ orgId, name, enabled: z.boolean() }),
    handler: async (input, ctx) =>
      summary(await setPluginEnabled(ctx.d1, ctx.orgId, input.name, input.enabled)),
  }),
];

const auth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer") }),
  z.object({ kind: z.literal("header"), header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
]);

export const gatewayOps = [
  defineOperation({
    name: "flow.gateway.list",
    description:
      "The org's gateways by name: each one's base URL, how it authenticates, and whether it has a secret. Never the secret.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ gateways: await listGateways(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.gateway.save",
    description:
      'Create the gateway `name`, or replace its base URL and auth: { kind: "none" } | { kind: "bearer" } (Authorization: Bearer <secret>) | { kind: "header", header } (<header>: <secret>). With `gatewayId`, change that gateway instead, its name too (a rename keeps its secret). `secret` sets the secret (stored encrypted, never shown again), null removes it, and leaving it out keeps it.',
    risk: "write",
    input: z.object({
      orgId,
      gatewayId: z.string().min(1).max(100).optional(),
      name,
      baseUrl: z.string().url().max(2_000),
      auth,
      secret: z.string().min(1).max(10_000).nullable().optional(),
    }),
    handler: (input, ctx) =>
      saveGateway(ctx.d1, ctx.host.FLOW_GATEWAY_KEY, {
        orgId: ctx.orgId,
        ...(input.gatewayId !== undefined ? { gatewayId: input.gatewayId } : {}),
        name: input.name,
        baseUrl: input.baseUrl,
        auth: input.auth,
        ...(input.secret !== undefined ? { secret: input.secret } : {}),
      }),
  }),
  defineOperation({
    name: "flow.gateway.delete",
    description:
      "Delete the gateway `name` (or the one with `gatewayId`). Plugins that use it then get an error when they call it.",
    risk: "write",
    input: z.union([
      z.object({ orgId, gatewayId: z.string().min(1).max(100) }),
      z.object({ orgId, name }),
    ]),
    handler: async (input, ctx) => {
      await deleteGateway(
        ctx.d1,
        ctx.orgId,
        "gatewayId" in input ? { id: input.gatewayId } : input.name,
      );
      return { ok: true };
    },
  }),
];
