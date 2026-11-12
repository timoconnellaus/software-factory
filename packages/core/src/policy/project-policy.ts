// A project's `.factory/policy.json`, read from the default branch at one SHA (ADR 0009, 0036). The
// GitHub connector mirrors it with `policy.sync` on each push to the default branch; a policy
// offered from any other ref is ignored. A missing or malformed policy fails closed: every
// non-human call on the project is denied until a valid one lands.

import {
  CAPABILITIES,
  type CheckCommand,
  checkName,
  harnessProfileSchema,
  JOB_STAGES,
  MODEL_ROLES,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { DEFAULT_REQUIRED_CHECKS } from "../verify/protection.ts";
import { AUTONOMY_POLICIES, type DecisionRules, rulesError } from "./gate.ts";

/** Where the policy lives in a project's repo. */
export const POLICY_PATH = ".factory/policy.json";

const sizes = ["small", "medium", "large"] as const;
export type SizeName = (typeof sizes)[number];

/** An org workflow's id (spec 52, ADR 0510): what a project's `workflow` names once it runs one. */
export const ORG_WORKFLOW_ID = /^wf_[a-z0-9_]{1,60}$/;
export const isOrgWorkflowId = (name: string | null | undefined): name is string =>
  !!name && ORG_WORKFLOW_ID.test(name);

/**
 * Whether the project runs an org workflow: `workflow` is shaped like an org workflow id and no slot
 * workflow in the config has that name. A slot workflow named like one before spec 52 PR (d) stays a
 * slot workflow, so an existing config runs exactly as before; only new slot workflows may not take
 * such a name (`config.save` refuses one).
 */
export function onOrgWorkflow(
  policy: { workflow: string | null; workflows: readonly { name: string }[] } | null,
): policy is { workflow: string; workflows: readonly { name: string }[] } {
  if (!policy || !isOrgWorkflowId(policy.workflow)) return false;
  const named = policy.workflow.toLowerCase();
  return !policy.workflows.some((w) => w.name.toLowerCase() === named);
}

/** Names people read and steps refer to. */
const label = z.string().trim().min(1).max(60);
const instructions = z.string().max(4_000).default("");

/**
 * An agent (ADR 0372): a harness-neutral profile a step hands to. It names a model role and tier,
 * never a model or a harness; the runner that takes the job resolves those.
 */
export const agentSchema = z
  .object({
    name: label,
    role: z.enum(MODEL_ROLES),
    tier: z.enum(["standard", "light"]).default("standard"),
    /** Standing instructions, appended to the prompt of every job this agent runs. */
    instructions,
    /** Capabilities its jobs need on top of the stage's (`requires`). */
    requires: z.array(z.enum(CAPABILITIES)).max(10).default([]),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentSchema>;

/**
 * A step in a workflow slot (ADR 0371). `work` hands to an agent and is advisory: its verdict is
 * pass, send back to build, or ask a person. `gate` hands to a person and is enforced.
 */
export const stepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a short id: lowercase letters, digits, -"),
    kind: z.enum(["work", "gate"]),
    name: label,
    /** work: the agent it hands to. */
    agent: label.optional(),
    /** gate: the GitHub login who decides; absent means the project's approvers. */
    approver: z.string().trim().min(1).max(100).optional(),
    instructions,
    /** Run only for items at least this size, or touching this decision domain. */
    when: z
      .object({
        sizeAtLeast: z.enum(sizes).optional(),
        domain: z.string().min(1).max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StepConfig = z.infer<typeof stepSchema>;

/**
 * A check the factory runs itself (ADR 0501): the runner host runs `run` in the job's worktree on
 * the head it hands back. Its result, not an agent's report, is what the verdict uses. Removing or
 * changing one loosens the config (a person).
 */
export const checkDeclSchema = z
  .object({
    name: checkName,
    run: z.string().trim().min(1).max(1_000),
    timeoutMinutes: z.number().int().min(1).max(60).default(15),
  })
  .strict();
export type CheckDecl = z.infer<typeof checkDeclSchema>;

export const SLOTS = ["afterSpec", "beforeVerify", "afterVerify"] as const;
export type SlotName = (typeof SLOTS)[number];

/**
 * A workflow (ADR 0371): a named preset that fills the fixed skeleton's three slots. Workflows only
 * add steps; the spec gate, verify and the merge gate always come from the skeleton.
 */
export const workflowSchema = z
  .object({
    name: label,
    description: z.string().max(500).default(""),
    slots: z
      .object({
        afterSpec: z.array(stepSchema).max(10).default([]),
        beforeVerify: z.array(stepSchema).max(10).default([]),
        afterVerify: z.array(stepSchema).max(10).default([]),
      })
      .strict()
      .default({ afterSpec: [], beforeVerify: [], afterVerify: [] }),
    /**
     * The agent for the build (role implement): its tier and standing instructions. Triage picks
     * the workflow, so it has none; verify and the reviewer stay code's own (ADR 0371).
     */
    core: z.object({ build: label.optional() }).strict().default({}),
    /** Checks this workflow adds to the project's own (ADR 0501). */
    checks: z.array(checkDeclSchema).max(10).default([]),
  })
  .strict();
export type WorkflowConfig = z.infer<typeof workflowSchema>;

/** The `modelRoles` keys: a role, or `<role>.light` for its light tier (ADR 0372). */
const MODEL_ROLE_KEYS: readonly string[] = MODEL_ROLES.flatMap((r) => [r, `${r}.light`]);

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
    /**
     * How many items may be in the pipeline at once (running, waiting or paused). Queued items are
     * pulled while the project is under it (ADR 0491).
     */
    activeLimit: z.number().int().positive().max(100).default(10),
    /**
     * How many items may be shaping at once (ADR 0493): shaping uses runners too, so a burst of it
     * can't crowd out released work.
     */
    shapingLimit: z.number().int().positive().max(100).default(5),
    /**
     * Who may release work from ready to queued (ADR 0491). A person always may; agents, intakes and
     * chat only with `agents: true`. Turning it on is a loosening, so only a person can.
     */
    release: z
      .object({ agents: z.boolean().default(false) })
      .strict()
      .default({ agents: false }),
    /** Automatic retries of a failed build or verify before the item fails (ADR 0005). */
    retryLimit: z.number().int().min(0).max(5).default(2),
    /** GitHub logins (or user ids) who decide gates. Empty: the org's owners and admins. */
    approvers: z.array(z.string().min(1)).default([]),
    /** Who gets a timed-out gate or question. Default: the first approver. */
    backupOwner: z.string().min(1).optional(),
    /** Model role → model, for this project's runs (ADR 0018). */
    modelRoles: z
      .record(z.string(), z.string().min(1))
      .default({})
      .superRefine((value, ctx) => {
        for (const key of Object.keys(value)) {
          if (!MODEL_ROLE_KEYS.includes(key)) {
            ctx.addIssue({ code: "custom", message: `unknown model role "${key}"` });
          }
        }
      }),
    /** Capabilities each stage's job requires (`.factory/` limits placement, ADR 0015). */
    requires: z.partialRecord(z.enum(JOB_STAGES), z.array(z.enum(CAPABILITIES))).default({}),
    /**
     * The harness's permission mode and allowlists per stage (ADR 0270). It can only pick a mode
     * and add allow rules and hosts; the deny rules and the sandbox are fixed in the harness. A
     * change here is a `.factory/` change, so it reaches runs only after a person merges it.
     */
    harness: harnessProfileSchema.optional(),
    /**
     * The default branch's protection (ADR 0280). `onRed: "block"` keeps build jobs queued while the
     * factory's check of the branch's rulesets is red; `warn` (the default) only shows it.
     * `requiredChecks` are the CI checks the generated ruleset requires besides `factory/verify`.
     */
    protection: z
      .object({
        onRed: z.enum(["warn", "block"]).default("warn"),
        requiredChecks: z
          .array(z.string().min(1).max(200))
          .max(20)
          .default([...DEFAULT_REQUIRED_CHECKS]),
      })
      .strict()
      .default({ onRed: "warn", requiredChecks: [...DEFAULT_REQUIRED_CHECKS] }),
    /**
     * The project's checks (ADR 0501): lint, typecheck, tests, whatever proves the work. The runner
     * host runs them on the head SHA after every build; the verdict needs each to pass there.
     */
    checks: z.array(checkDeclSchema).max(10).default([]),
    /** Review packet sections in order (ADR 0020, spec 14). */
    reviewPacket: z.object({ sections: z.array(z.string().min(1)).min(1) }).optional(),
    /** Agents steps hand to (ADR 0372). */
    agents: z.array(agentSchema).max(30).default([]),
    /** Named workflows (ADR 0371). The project runs the one named by `workflow` (ADR 0492). */
    workflows: z.array(workflowSchema).max(20).default([]),
    /**
     * The project's workflow (ADR 0492): every item follows it. Null: the skeleton alone. An org
     * workflow by id (`wf_…`, spec 52 PR (d)), or a slot workflow above by name. There is no
     * per-item override.
     */
    workflow: z.string().min(1).max(100).nullable().default(null),
    /**
     * The project's overrides of its org workflow's stage settings (spec 52, Q5): `{ [stageId]: {
     * setting: value } }`, only the settings each stage type lists as `overridable`, checked
     * against the org workflow when saved. Only with an org workflow.
     */
    workflowOverrides: z
      .record(z.string().min(1).max(40), z.record(z.string().min(1).max(40), z.unknown()))
      .default({})
      .refine((o) => Object.keys(o).length <= 20, "at most 20 stages can be overridden"),
    /**
     * Self-improvement (ADR 0373): the factory trials practice changes on the next `trialSize`
     * items, at most `weeklyCap` a week. Turning it on is a policy change for a person.
     */
    improve: z
      .object({
        enabled: z.boolean().default(false),
        trialSize: z.number().int().min(3).max(20).default(5),
        weeklyCap: z.number().int().min(1).max(10).default(3),
      })
      .strict()
      .default({ enabled: false, trialSize: 5, weeklyCap: 3 }),
    /**
     * The adjudicator per gate kind (ADR 0374): `shadow` records the verdict it would give,
     * `active` approves (never rejects) once it has earned it. Never merge, deploy or self-modify.
     */
    adjudicator: z
      .object({
        spec: z.enum(["off", "shadow", "active"]).default("off"),
        step: z.enum(["off", "shadow", "active"]).default("off"),
      })
      .strict()
      .default({ spec: "off", step: "off" }),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const error = workflowsError(policy.agents, policy.workflows);
    if (error) ctx.addIssue({ code: "custom", path: ["workflows"], message: error });
    const org = onOrgWorkflow(policy);
    if (!org && Object.keys(policy.workflowOverrides).length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["workflowOverrides"],
        message: "overrides apply to an org workflow: set `workflow` to one (wf_…) first",
      });
    const checks = checksError(policy.checks, policy.workflows);
    if (checks) ctx.addIssue({ code: "custom", path: ["checks"], message: checks });
    const named = org ? undefined : policy.workflow?.toLowerCase();
    if (named && !policy.workflows.some((w) => w.name.toLowerCase() === named)) {
      ctx.addIssue({
        code: "custom",
        path: ["workflow"],
        message: `no workflow called "${policy.workflow}"`,
      });
    }
  });

/** Two checks with one name would make a criterion's link ambiguous. */
function checksError(project: CheckDecl[], workflows: WorkflowConfig[]): string | null {
  for (const list of [project, ...workflows.map((w) => [...project, ...w.checks])]) {
    const seen = new Set<string>();
    for (const c of list) {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return `two checks are called "${c.name}"`;
      seen.add(key);
    }
  }
  return null;
}

/**
 * The checks an item runs (ADR 0501): the project's, then its workflow's, as the job carries them.
 * Empty when the project declares none.
 */
export function declaredChecks(
  policy: Pick<ProjectPolicy, "checks" | "workflows"> | null,
  workflow: string | null,
): CheckCommand[] {
  if (!policy) return [];
  const w = workflow
    ? policy.workflows.find((x) => x.name.toLowerCase() === workflow.toLowerCase())
    : undefined;
  return [...policy.checks, ...(w?.checks ?? [])].map((c) => ({
    name: c.name,
    run: c.run,
    timeoutMs: c.timeoutMinutes * 60_000,
  }));
}

/** Cross-references between agents and workflows that the schema alone can't check. */
function workflowsError(agents: AgentConfig[], workflows: WorkflowConfig[]): string | null {
  const byName = new Map<string, AgentConfig>();
  for (const a of agents) {
    if (byName.has(a.name.toLowerCase())) return `two agents are called "${a.name}"`;
    byName.set(a.name.toLowerCase(), a);
  }
  const names = new Set<string>();
  for (const w of workflows) {
    if (names.has(w.name.toLowerCase())) return `two workflows are called "${w.name}"`;
    names.add(w.name.toLowerCase());
    const ids = new Set<string>();
    for (const slot of SLOTS) {
      for (const step of w.slots[slot]) {
        const where = `${w.name} → ${step.name}`;
        if (ids.has(step.id)) return `${w.name}: two steps have the id "${step.id}"`;
        ids.add(step.id);
        if (step.kind === "work") {
          if (!step.agent) return `${where}: a work step hands to an agent`;
          const agent = byName.get(step.agent.toLowerCase());
          if (!agent) return `${where}: no agent called "${step.agent}"`;
          // Work steps are advisory: they read and report, they never build.
          if (agent.role === "implement") {
            return `${where}: a work step can't use "${agent.name}" (role implement): work steps report, they don't build`;
          }
          if (step.approver) return `${where}: a work step has no approver (that's a gate step)`;
        } else if (step.agent) {
          return `${where}: a gate step hands to a person, not an agent`;
        }
      }
    }
    for (const [core, role] of [["build", "implement"]] as const) {
      const name = w.core[core];
      if (!name) continue;
      const agent = byName.get(name.toLowerCase());
      if (!agent) return `${w.name}: no agent called "${name}" for ${core}`;
      if (agent.role !== role) {
        return `${w.name}: the ${core} agent needs role ${role} ("${agent.name}" is ${agent.role})`;
      }
    }
  }
  return null;
}

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
  // Approvals of looser overrides are the factory's own record (core_override_approvals), never
  // a document's: a field of that name in a saved or imported config is dropped, not honoured.
  if (value && typeof value === "object" && !Array.isArray(value))
    delete (value as Record<string, unknown>).workflowOverrideApprovals;
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
