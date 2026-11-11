// A project's `.factory/policy.json`, read from the default branch at one SHA (ADR 0009, 0036). The
// GitHub connector mirrors it with `policy.sync` on each push to the default branch; a policy
// offered from any other ref is ignored. A missing or malformed policy fails closed: every
// non-human call on the project is denied until a valid one lands.

import {
  CAPABILITIES,
  harnessProfileSchema,
  JOB_STAGES,
  MODEL_ROLES,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { AUTONOMY_POLICIES, type DecisionRules, rulesError } from "./gate.ts";

/** Where the policy lives in a project's repo. */
export const POLICY_PATH = ".factory/policy.json";

const sizes = ["small", "medium", "large"] as const;
export type SizeName = (typeof sizes)[number];

export const projectPolicySchema = z
  .object({
    version: z.literal(1),
    /** Cautious, Balanced or Autonomous (ADR 0008). */
    autonomyPolicy: z.enum(AUTONOMY_POLICIES),
    /** actor → risk class → allow|review|deny. The floor still applies on top. */
    overrides: z
      .record(z.string(), z.record(z.string(), z.string()))
      .default({})
      .superRefine((value, ctx) => {
        const error = rulesError(value);
        if (error) ctx.addIssue({ code: "custom", message: error });
      }),
    spec: z
      .object({
        /**
         * The smallest size that needs a spec gate (ADR 0013). `small` = every item; `never` is not
         * offered: `large` work always gets a spec.
         */
        requiredFrom: z.enum(sizes).default("medium"),
      })
      .default({ requiredFrom: "medium" }),
    timeouts: z
      .object({
        /** Hours a gate waits before it goes to the backup owner (never auto-accepted). */
        gateHours: z
          .number()
          .positive()
          .max(24 * 60)
          .default(72),
        questionHours: z
          .number()
          .positive()
          .max(24 * 60)
          .default(48),
      })
      .default({ gateHours: 72, questionHours: 48 }),
    /** How many items may wait at human gates before new builds stop (ADR 0040). */
    wipLimit: z.number().int().positive().max(100).default(5),
    /** Automatic retries of a failed build or verify before the item fails (ADR 0005). */
    retryLimit: z.number().int().min(0).max(5).default(2),
    /** GitHub logins (or user ids) who decide gates. Empty: the org's owners and admins. */
    approvers: z.array(z.string().min(1)).default([]),
    /** Who gets a timed-out gate or question. Default: the first approver. */
    backupOwner: z.string().min(1).optional(),
    /** Model role → model, for this project's runs (ADR 0018). */
    modelRoles: z.partialRecord(z.enum(MODEL_ROLES), z.string().min(1)).default({}),
    /** Capabilities each stage's job requires (`.factory/` limits placement, ADR 0015). */
    requires: z.partialRecord(z.enum(JOB_STAGES), z.array(z.enum(CAPABILITIES))).default({}),
    /**
     * The harness's permission mode and allowlists per stage (ADR 0270). It can only pick a mode
     * and add allow rules and hosts; the deny rules and the sandbox are fixed in the harness. A
     * change here is a `.factory/` change, so it reaches runs only after a person merges it.
     */
    harness: harnessProfileSchema.optional(),
    /** Review packet sections in order (ADR 0020, spec 14). */
    reviewPacket: z.object({ sections: z.array(z.string().min(1)).min(1) }).optional(),
  })
  .strict();

export type ProjectPolicy = z.infer<typeof projectPolicySchema> & { overrides: DecisionRules };

export type PolicyParse = { ok: true; policy: ProjectPolicy } | { ok: false; error: string };

/** Parses `.factory/policy.json` text. Never throws. */
export function parseProjectPolicy(raw: string): PolicyParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "policy is not JSON" };
  }
  const parsed = projectPolicySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") || "policy"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, policy: parsed.data as ProjectPolicy };
}

const SIZE_RANK: Record<SizeName, number> = { small: 0, medium: 1, large: 2 };

/**
 * Whether a work item of this size needs the spec gate. Code, not the foreman: the foreman's
 * `specRequested` can only add a spec, never skip one the policy requires (spec 02, criterion 4).
 */
export function specRequired(
  policy: Pick<ProjectPolicy, "spec">,
  size: SizeName,
  requested?: "skip" | "require",
): { required: boolean; reason: string } {
  const threshold = policy.spec.requiredFrom;
  const byPolicy = size === "large" || SIZE_RANK[size] >= SIZE_RANK[threshold];
  if (byPolicy) {
    return {
      required: true,
      reason:
        requested === "skip"
          ? `the foreman asked to skip the spec, but policy requires one from ${threshold} and this is ${size}`
          : `policy requires a spec from ${threshold}; triage sized this ${size}`,
    };
  }
  if (requested === "require") {
    return { required: true, reason: `sized ${size}, but the foreman asked for a spec` };
  }
  return {
    required: false,
    reason: `sized ${size}, below the spec threshold (${threshold})`,
  };
}
