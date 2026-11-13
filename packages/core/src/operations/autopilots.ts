// Autopilots in the org config (ADR 0514, spec 52 build step (g), first part): read them, and add,
// change, turn on or off one through the org config version, like any org config save. Firing and
// runs (migration 0284, the cron and events, the runner channel's outputs) come next.
import { z } from "zod";
import { type AutopilotConfig, autopilotSchema } from "../autopilots/schema.ts";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { OrgConfig } from "../stages/org-config.ts";
// workflows.ts imports this file (to apply an approved save), so only its functions are used here,
// at call time; the input schemas are this file's own.
import {
  currentOrgConfig,
  orgProjects,
  requireBase,
  riskOfSave,
  validated,
  writeOrgVersion,
} from "./workflows.ts";

const orgId = z.string().min(1);
const baseVersion = z.number().int().nonnegative();
const note = z.string().trim().max(500).optional();
const autopilotId = z.string().min(1).max(64);

const autopilotView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  trigger: z.record(z.string(), z.unknown()),
  agent: z.string(),
  skills: z.array(z.string()),
  instructions: z.string(),
  scope: z.object({ projects: z.union([z.literal("all"), z.array(z.string())]) }),
  output: z.record(z.string(), z.unknown()),
  limits: z.object({ minutes: z.number(), maxOutputs: z.number(), runsPerDay: z.number() }),
  requires: z.array(z.string()),
});

export function withAutopilot(config: OrgConfig, autopilot: AutopilotConfig): OrgConfig {
  const exists = config.autopilots.some((a) => a.id === autopilot.id);
  return {
    ...config,
    autopilots: exists
      ? config.autopilots.map((a) => (a.id === autopilot.id ? autopilot : a))
      : [...config.autopilots, autopilot],
  };
}

export function withAutopilotEnabled(config: OrgConfig, id: string, enabled: boolean): OrgConfig {
  if (!config.autopilots.some((a) => a.id === id))
    throw new OperationError("not_found", `the org has no autopilot ${id}`);
  return {
    ...config,
    autopilots: config.autopilots.map((a) => (a.id === id ? { ...a, enabled } : a)),
  };
}

/** Every project an autopilot names is one of the org's (its scope, its events, its output). */
export async function requireOrgProjects(ctx: HandlerContext, org: string, a: AutopilotConfig) {
  const ids = new Set((await orgProjects(ctx.db, org)).map((p) => p.id));
  const named = [
    ...(a.scope.projects === "all" ? [] : a.scope.projects),
    ...(a.trigger.kind === "event" ? (a.trigger.projects ?? []) : []),
    ...(a.output.kind === "backlog" && a.output.project !== "each" ? [a.output.project] : []),
  ];
  const unknown = named.filter((p) => !ids.has(p));
  if (unknown.length)
    throw new OperationError(
      "invalid_input",
      `the autopilot ${a.name} names projects that aren't the org's: ${unknown.join(", ")}`,
    );
  if (
    a.trigger.kind === "event" &&
    a.trigger.projects &&
    a.scope.projects !== "all" &&
    a.trigger.projects.some((p) => !(a.scope.projects as readonly string[]).includes(p))
  )
    throw new OperationError(
      "invalid_input",
      `the autopilot ${a.name} fires on events of projects outside its scope`,
    );
  if (
    a.output.kind === "backlog" &&
    a.output.project !== "each" &&
    a.scope.projects !== "all" &&
    !a.scope.projects.includes(a.output.project)
  )
    throw new OperationError(
      "invalid_input",
      `the autopilot ${a.name} files into ${a.output.project}, which isn't in its scope`,
    );
}

export async function saveAutopilot(
  ctx: HandlerContext,
  input: {
    orgId: string;
    baseVersion: number;
    autopilot: z.input<typeof autopilotSchema>;
    note?: string | undefined;
  },
  createdBy?: string,
) {
  const autopilot = autopilotSchema.parse(input.autopilot);
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  await requireOrgProjects(ctx, input.orgId, autopilot);
  const exists = config.autopilots.some((a) => a.id === autopilot.id);
  const after = validated(withAutopilot(config, autopilot));
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || `${exists ? "Changed" : "Added"} the autopilot ${autopilot.name}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

export async function setAutopilotEnabled(
  ctx: HandlerContext,
  input: { orgId: string; baseVersion: number; autopilotId: string; note?: string | undefined },
  enabled: boolean,
  createdBy?: string,
) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  // Turning one on: it still names only the org's projects (review of #197).
  const target = config.autopilots.find((a) => a.id === input.autopilotId);
  if (enabled && target) await requireOrgProjects(ctx, input.orgId, target);
  const after = validated(withAutopilotEnabled(config, input.autopilotId, enabled));
  const name = config.autopilots.find((a) => a.id === input.autopilotId)?.name ?? input.autopilotId;
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || `Turned ${enabled ? "on" : "off"} the autopilot ${name}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

export const autopilotList = defineOperation({
  name: "autopilot.list",
  description:
    "An org's autopilots (ADR 0514): work the factory starts on its own, each a trigger, an org agent, instructions, a scope of projects and an output (backlog items, labels, a digest or proposals). They file work and never ship it. Members only.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId }),
  output: z.object({ version: z.number(), autopilots: z.array(autopilotView) }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    return { version, autopilots: config.autopilots };
  },
});

export const autopilotGet = defineOperation({
  name: "autopilot.get",
  description:
    "One of an org's autopilots, as the current org config version has it. Members only.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId, autopilotId }),
  output: z.object({ version: z.number(), autopilot: autopilotView }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const autopilot = config.autopilots.find((a) => a.id === input.autopilotId);
    if (!autopilot)
      throw new OperationError("not_found", `the org has no autopilot ${input.autopilotId}`);
    return { version, autopilot };
  },
});

export const autopilotSave = defineOperation({
  name: "autopilot.save",
  description:
    "Add an org autopilot, or replace one by id (ADR 0514): its trigger (an hourly-at-most schedule, or an event), the org agent it hands to, its skills, its instructions, the projects it reaches, its output and its limits. Judged by reach: changing one that is off is practice; one that is on (or saved on) loosens when it would do anything it couldn't before (fire at new times, reach more projects or events, another agent, capabilities, skills, output, limits or instructions), so it waits for an org admin. Org admins only; on the desktop with a presence proof.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      withAutopilot(c, autopilotSchema.parse(input.autopilot)),
    ),
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // On the desktop with a presence proof for this exact call (ADR 0610); never the phone.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({ orgId, baseVersion, autopilot: autopilotSchema, note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return saveAutopilot(ctx, input);
  },
});

const toggleInput = z.object({ orgId, baseVersion, autopilotId, note });

export const autopilotEnable = defineOperation({
  name: "autopilot.enable",
  description:
    "Turn an org autopilot on (ADR 0514). Always a loosening (what it reaches is judged when it is turned on), so it waits for an org admin; on the desktop with a presence proof. Org admins only.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      withAutopilotEnabled(c, input.autopilotId, true),
    ),
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: toggleInput,
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return setAutopilotEnabled(ctx, input, true);
  },
});

export const autopilotDisable = defineOperation({
  name: "autopilot.disable",
  description:
    "Turn an org autopilot off (ADR 0514): a tightening, applied at once. Org admins only, in the app.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // A tightening: one tap on the desktop, no proof (review of #197). Never the phone.
  desktopOneTap: () => true,
  input: toggleInput,
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return setAutopilotEnabled(ctx, input, false);
  },
});
