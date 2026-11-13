// Autopilots in the org config (ADR 0514, spec 52 build step (g), first part): read them, and add,
// change, turn on or off one through the org config version, like any org config save. Firing and
// runs (migration 0284, the cron and events, the runner channel's outputs) come next.
import { sql } from "kysely";
import { z } from "zod";
import { type AutopilotConfig, autopilotSchema } from "../autopilots/schema.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { activeKillSwitch } from "../scope.ts";
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

const runResult = z.object({
  runId: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  workItemId: z.string().nullable(),
  duplicate: z.boolean(),
});

const runView = z.object({
  id: z.string(),
  trigger: z.string(),
  dedupeKey: z.string(),
  orgConfigVersion: z.number(),
  projectId: z.string().nullable(),
  workItemId: z.string().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  outputs: z.array(z.unknown()),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});

const runOf = (r: {
  id: string;
  trigger: string;
  dedupe_key: string;
  org_config_version: number;
  project_id: string | null;
  work_item_id: string | null;
  status: string;
  reason: string | null;
  outputs: string;
  created_at: string;
  ended_at: string | null;
}) => {
  let outputs: unknown[] = [];
  try {
    const v = JSON.parse(r.outputs) as unknown;
    outputs = Array.isArray(v) ? v : [];
  } catch {
    outputs = [];
  }
  return {
    id: r.id,
    trigger: r.trigger,
    dedupeKey: r.dedupe_key,
    orgConfigVersion: r.org_config_version,
    projectId: r.project_id,
    workItemId: r.work_item_id,
    status: r.status,
    reason: r.reason,
    outputs,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
};

/** Why a run can't do its work yet: no runner job stage for autopilots before build step (g2b). */
export const NO_AUTOPILOT_RUNNER = "no runner supports autopilots yet";

/**
 * Starts one firing of an autopilot (ADR 0514): one occurrence fires once (its dedupe key), at most
 * `runsPerDay` a day (UTC), only while it is on in the org's current config. The run is a work item
 * the Work lists leave out (`item_kind` = autopilot). Until runners support autopilots (g2b) it
 * ends at once, saying so: it never waits or holds a slot.
 */
export async function startAutopilotRun(
  ctx: HandlerContext,
  input: {
    orgId: string;
    autopilotId: string;
    trigger: "schedule" | "event" | "manual";
    dedupeKey: string;
    projectId?: string | undefined;
    requesterUserId: string;
  },
): Promise<{
  runId: string;
  status: string;
  reason: string | null;
  workItemId: string | null;
  duplicate: boolean;
}> {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  const a = config.autopilots.find((x) => x.id === input.autopilotId);
  if (!a) throw new OperationError("not_found", `the org has no autopilot ${input.autopilotId}`);
  // A project named must be the org's, and in the autopilot's scope (review of #203).
  const projects = (await orgProjects(ctx.db, input.orgId)).map((p) => p.id);
  if (input.projectId && !projects.includes(input.projectId))
    throw new OperationError("invalid_input", "that project isn't one of the org's");
  // One occurrence fires once: the same key finds the run it started (UNIQUE (org_id, dedupe_key)).
  const seen = await ctx.db
    .selectFrom("core_autopilot_runs")
    .select(["id", "status", "reason", "work_item_id"])
    .where("org_id", "=", input.orgId)
    .where("dedupe_key", "=", input.dedupeKey)
    .executeTakeFirst();
  if (seen)
    return {
      runId: seen.id,
      status: seen.status,
      reason: seen.reason,
      workItemId: seen.work_item_id,
      duplicate: true,
    };
  const runId = newId("autopilotRun");
  const manual = input.trigger === "manual";
  // Why it doesn't run. A person's run now is answered, and nothing is written (review of #203:
  // repeated calls can't grow the history); a firing records one skipped row for its occurrence,
  // bounded by its trigger (at most hourly, and one per event).
  const skip = (reason: string, projectId: string | null) => {
    if (manual) throw new OperationError("conflict", `it doesn't run: ${reason}`);
    ctx.write(
      ctx.db.insertInto("core_autopilot_runs").values({
        id: runId,
        org_id: input.orgId,
        autopilot_id: a.id,
        org_config_version: version,
        trigger: input.trigger,
        dedupe_key: input.dedupeKey,
        project_id: projectId,
        work_item_id: null,
        status: "skipped",
        reason,
        created_by: ctx.actor.id,
        created_at: ctx.now,
        ended_at: ctx.now,
      }),
    );
    ctx.change({
      entity: "autopilot_run",
      id: runId,
      after: { autopilot: a.id, status: "skipped", reason },
    });
    return { runId, status: "skipped", reason, workItemId: null, duplicate: false };
  };
  if (!a.enabled) return skip("the autopilot is off", null);
  // The project its run belongs to: the one it was fired for, else the first in its scope.
  const inScope =
    a.scope.projects === "all" ? projects : a.scope.projects.filter((p) => projects.includes(p));
  const projectId = input.projectId ?? inScope[0] ?? null;
  if (!projectId || !inScope.includes(projectId))
    return skip("no project in its scope to run for", projectId);
  // A kill switch on the org or the project stops a run, for a person's run now too (review of #203).
  const kill = await activeKillSwitch(ctx.db, input.orgId, projectId);
  if (kill) return skip(`the ${kill.scope} kill switch is on`, projectId);
  // Its daily cap (UTC), counted in SQL over the day's runs that ran: skipped ones never fill it
  // (review of #203). core_autopilot_runs_autopilot_idx: this autopilot's runs today, a few dozen.
  const day = `${ctx.now.slice(0, 10)}T00:00:00.000Z`;
  const ran = await ctx.db
    .selectFrom("core_autopilot_runs")
    .select(sql<number>`count(*)`.as("n"))
    .where("org_id", "=", input.orgId)
    .where("autopilot_id", "=", a.id)
    .where("created_at", ">=", day)
    .where("status", "!=", "skipped")
    .executeTakeFirst();
  if (Number(ran?.n ?? 0) >= a.limits.runsPerDay)
    return skip(`it already ran ${a.limits.runsPerDay} times today (its daily cap)`, projectId);
  // The run, written only while the day's count is still under the cap (two at once can't pass it).
  // Until runners support autopilots (g2b) it ends at once, with no work item: nothing to hold.
  ctx.write(
    ctx.d1
      .prepare(
        `INSERT INTO core_autopilot_runs (id, org_id, autopilot_id, org_config_version, trigger,
           dedupe_key, project_id, work_item_id, status, reason, created_by, created_at, ended_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 'failed', ?, ?, ?, ?
         WHERE (SELECT count(*) FROM core_autopilot_runs WHERE org_id = ? AND autopilot_id = ?
                AND created_at >= ? AND status != 'skipped') < ?`,
      )
      .bind(
        runId,
        input.orgId,
        a.id,
        version,
        input.trigger,
        input.dedupeKey,
        projectId,
        NO_AUTOPILOT_RUNNER,
        ctx.actor.id,
        ctx.now,
        ctx.now,
        input.orgId,
        a.id,
        day,
        a.limits.runsPerDay,
      ),
  );
  ctx.guardChanged("the autopilot's daily cap");
  ctx.change({
    entity: "autopilot_run",
    id: runId,
    after: {
      autopilot: a.id,
      trigger: input.trigger,
      status: "failed",
      reason: NO_AUTOPILOT_RUNNER,
    },
  });
  return {
    runId,
    status: "failed",
    reason: NO_AUTOPILOT_RUNNER,
    workItemId: null,
    duplicate: false,
  };
}

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
  output: z.object({ version: z.number(), autopilot: autopilotView, runs: z.array(runView) }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const autopilot = config.autopilots.find((a) => a.id === input.autopilotId);
    if (!autopilot)
      throw new OperationError("not_found", `the org has no autopilot ${input.autopilotId}`);
    // Its run history, newest first (core_autopilot_runs_autopilot_idx), the last 20.
    const runs = await ctx.db
      .selectFrom("core_autopilot_runs")
      .selectAll()
      .where("org_id", "=", input.orgId)
      .where("autopilot_id", "=", input.autopilotId)
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();
    return { version, autopilot, runs: runs.map(runOf) };
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

export const autopilotRunNow = defineOperation({
  name: "autopilot.runNow",
  description:
    "Run one of an org's autopilots now (ADR 0514), as a person: once per call, within its daily cap, only while it is on. The run shows in its history (autopilot.get) and is left out of the Work lists. Until runners support autopilots it ends at once, saying so. Members only.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId, autopilotId, projectId: z.string().min(1).max(64).optional() }),
  // Scoped by the org (review of #203): the member check is the org's; the project is checked to
  // be the org's in the handler.
  scope: async (input) => ({ orgId: input.orgId }),
  output: runResult,
  async handler(input, ctx) {
    return startAutopilotRun(ctx, {
      orgId: input.orgId,
      autopilotId: input.autopilotId,
      trigger: "manual",
      dedupeKey: `manual:${newId("autopilotRun")}`,
      projectId: input.projectId,
      requesterUserId: ctx.actor.id,
    });
  },
});

export const autopilotFire = defineOperation({
  name: "autopilot.fire",
  description:
    "Fire an org autopilot for one occurrence of its trigger (ADR 0514): the minute cron for a schedule, the outbox for an event. The occurrence's dedupe key fires it once; its daily cap and its being on are checked here. The factory's own call; nothing calls it yet (firing comes with build step (g2c)).",
  risk: "write",
  actors: ["scheduler"],
  permission: "signed-in",
  input: z.object({
    orgId,
    autopilotId,
    trigger: z.enum(["schedule", "event"]),
    dedupeKey: z.string().min(1).max(200),
    projectId: z.string().min(1).max(64).optional(),
    requesterUserId: z.string().min(1).max(64),
  }),
  scope: async (input) => ({ orgId: input.orgId }),
  output: runResult,
  async handler(input, ctx) {
    return startAutopilotRun(ctx, input);
  },
});
