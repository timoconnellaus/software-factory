// A workflow is data that only chooses stage types, orders them and configures them (ADR 0510).
import { z } from "zod";
import { stageSkillSchema } from "../skills/schema.ts";
import { PHASES } from "./contract.ts";
import { conditionSchema } from "./settings.ts";

export const STAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The fixed work-management states every workflow shares (spec 50). No stage may take their ids. */
export const FIXED_STATES = ["backlog", "ready", "queued", "done"] as const;
export const MAX_STAGES = 20;

export const stageInstanceSchema = z
  .object({
    /** Stable across versions: the lane id, `core_work_items.stage`, idempotency keys. */
    id: z.string(),
    /** A registered stage type id. */
    type: z.string().min(1).max(60),
    /** The registry's version of the type when this was saved. */
    typeVersion: z.number().int().positive(),
    /** The lane's label. */
    name: z.string().trim().min(1).max(60),
    phase: z.enum(PHASES),
    /** Parsed by the type's own schema (rule S1). */
    settings: z.unknown().default({}),
    /** Skip the stage for an item. Not on a required gate or an irreversible stage (F7). */
    when: conditionSchema.optional(),
    /** The org agent its agent steps hand to (ADR 0372). Absent: the type's built-in agent. */
    agent: z.string().trim().min(1).max(60).optional(),
    /** Skills attached here (ADR 0513), each optionally under a condition. */
    skills: z.array(stageSkillSchema).max(20).optional(),
  })
  .strict();
export type StageInstance = z.infer<typeof stageInstanceSchema>;

export const workflowDefinitionSchema = z
  .object({
    schema: z.literal(1),
    /** Stable across versions; items and projects refer to it. */
    id: z.string().regex(/^wf_[a-z0-9_]{1,60}$/),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    /** The template it was copied from. */
    template: z
      .object({ id: z.string(), version: z.number().int().positive() })
      .strict()
      .optional(),
    stages: z.array(stageInstanceSchema).max(MAX_STAGES),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
