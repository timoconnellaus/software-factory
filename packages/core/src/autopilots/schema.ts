// Autopilots (ADR 0514, spec 52 § Autopilots): work the factory starts on its own. A trigger (a
// schedule or an event), an org agent, an instruction, a scope of projects and an output target.
// They live in the org config version and change only through org config saves (human); this file
// is the shape and its checks, `impact.ts` how a change classifies.
import { CAPABILITIES } from "@software-factory/runner-contract";
import { z } from "zod";
import { anySkillIdSchema, hasHidden } from "../skills/schema.ts";
import { parseCron } from "./cron.ts";

export const AUTOPILOT_EVENTS = [
  "ci.failedOnDefaultBranch",
  "incident.opened",
  "workItem.captured",
  "workItem.done",
] as const;
export type AutopilotEvent = (typeof AUTOPILOT_EVENTS)[number];

/** Most autopilots an org keeps. */
export const MAX_AUTOPILOTS = 20;

/** Why a cron isn't one an autopilot runs, or null (the one evaluator, `cron.ts`). */
export function cronError(cron: string): string | null {
  const parsed = parseCron(cron);
  return parsed.ok ? null : parsed.error;
}

const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "an IANA time zone, such as Australia/Sydney");

const projectIds = z.array(z.string().min(1).max(64)).min(1).max(50);

export const autopilotTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("schedule"),
      cron: z
        .string()
        .max(100)
        .superRefine((c, ctx) => {
          const e = cronError(c);
          if (e) ctx.addIssue({ code: "custom", message: e });
        }),
      timezone: timezone.default("UTC"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      event: z.enum(AUTOPILOT_EVENTS),
      /** The projects whose events fire it; absent: every project in its scope. */
      projects: projectIds.optional(),
    })
    .strict(),
]);

export const autopilotOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("backlog"),
      /** A project id, or "each": the project its finding is about, within its scope. */
      project: z.string().min(1).max(64),
      /** `queued` releases work, only where the project lets agents release (spec 50). */
      state: z.enum(["backlog", "ready", "queued"]).default("backlog"),
      priority: z.number().int().min(0).max(3).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("labels") }).strict(),
  z.object({ kind: z.literal("digest") }).strict(),
  z.object({ kind: z.literal("proposals") }).strict(),
]);

export const autopilotLimitsSchema = z
  .object({
    /** The run's session timeout. */
    minutes: z.number().int().min(1).max(60).default(30),
    /** Items, labels or proposals one run may produce. */
    maxOutputs: z.number().int().min(1).max(20).default(5),
    /** Firings a day (UTC). */
    runsPerDay: z.number().int().min(1).max(24).default(4),
  })
  .strict();

export const autopilotSchema = z
  .object({
    id: z.string().regex(/^ap_[a-z0-9][a-z0-9-]{0,39}$/, "ap_ then a short lowercase id"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((t) => !hasHidden(t), "no control or invisible characters in the name"),
    description: z
      .string()
      .max(500)
      .refine((t) => !hasHidden(t), "no control or invisible characters in the description")
      .default(""),
    enabled: z.boolean().default(false),
    trigger: autopilotTriggerSchema,
    /** An org agent, by name. */
    agent: z.string().trim().min(1).max(60),
    /** Skills it follows on top of its agent's own (ADR 0513): the org's, or built-ins. */
    skills: z.array(anySkillIdSchema).max(20).default([]),
    /** At most 4 kB (bytes, not characters); newlines and tabs only. */
    instructions: z
      .string()
      .refine((t) => new TextEncoder().encode(t).length <= 4_000, "instructions are at most 4 kB")
      .refine((t) => !hasHidden(t, true), "no control or invisible characters in the instructions")
      .default(""),
    /** The projects it reads and files into. */
    scope: z
      .object({ projects: z.union([z.literal("all"), projectIds]) })
      .strict()
      .default({ projects: "all" }),
    output: autopilotOutputSchema,
    limits: autopilotLimitsSchema.default({ minutes: 30, maxOutputs: 5, runsPerDay: 4 }),
    requires: z.array(z.enum(CAPABILITIES)).max(10).default([]),
  })
  .strict();
export type AutopilotConfig = z.infer<typeof autopilotSchema>;

/** The projects an autopilot may touch, given the org's projects. */
export function scopeOf(a: AutopilotConfig, orgProjects: readonly string[]): string[] {
  return a.scope.projects === "all"
    ? [...orgProjects]
    : a.scope.projects.filter((p) => orgProjects.includes(p));
}
