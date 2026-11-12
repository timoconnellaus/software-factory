// Self-improvement operations (ADR 0373, spec 09 M3). The improver (actor `self-improve`) scans a
// project's finished work, starts a trial of a practice change on the next N items, and resolves it:
// promoted when outcomes hold up, disabled when they don't. A person can stop a trial at any time,
// and revert a promoted one with config.rollback.
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  type Candidate,
  DEFAULT_BUILDER,
  draftCandidate,
  evaluateTrial,
  recentOutcomes,
} from "../improve.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { policyImpact, same } from "../policy/impact.ts";
import { type ProjectPolicy, parseProjectPolicy } from "../policy/project-policy.ts";
import { formatPolicy, versionKey, versionOf } from "./config.ts";
import { projectId, requireProject } from "./shared.ts";

/** A trial decides on what it has after this long, even short of its items. */
export const TRIAL_MAX_DAYS = 14;
/** A disabled change isn't drafted again for this long. */
const RETRY_AFTER_DAYS = 30;

const trialId = z.string().regex(/^trl_[0-9a-f]{32}$/, "a trial id (trl_…)");

const daysAgo = (now: string, days: number) =>
  new Date(Date.parse(now) - days * 86_400_000).toISOString();

/**
 * Practice only (ADR 0373): the candidate may change nothing but agents' tier and instructions, or
 * add the default builder; and it must not loosen anything the impact summary can see.
 */
export function practiceOnlyError(
  current: ProjectPolicy,
  candidate: ProjectPolicy,
  floor: Parameters<typeof policyImpact>[2],
): string | null {
  for (const key of new Set([...Object.keys(current), ...Object.keys(candidate)])) {
    if (key === "agents") continue;
    if (
      !same((current as Record<string, unknown>)[key], (candidate as Record<string, unknown>)[key])
    ) {
      return `a practice change can't touch ${key}`;
    }
  }
  for (const agent of candidate.agents) {
    const was = current.agents.find((a) => a.name.toLowerCase() === agent.name.toLowerCase());
    if (!was) {
      if (
        agent.name.toLowerCase() !== DEFAULT_BUILDER.toLowerCase() ||
        agent.role !== "implement"
      ) {
        return `a practice change can only add the ${DEFAULT_BUILDER} agent`;
      }
      if (agent.requires.length) return "a new agent can't require capabilities";
      continue;
    }
    if (was.role !== agent.role || !same(was.requires, agent.requires)) {
      return `a practice change can only change ${agent.name}'s tier and instructions`;
    }
  }
  if (current.agents.some((a) => !candidate.agents.find((b) => b.name === a.name))) {
    return "a practice change can't remove an agent";
  }
  if (policyImpact(current, candidate, floor).class === "loosens") {
    return "it loosens the config, so it's a policy change for a person";
  }
  return null;
}

const outcomeView = z.object({
  decision: z.enum(["promote", "disable", "wait"]),
  reason: z.string(),
  trial: z.object({
    items: z.number(),
    doneRate: z.number(),
    rounds: z.number(),
    tokens: z.number(),
  }),
  base: z
    .object({ items: z.number(), doneRate: z.number(), rounds: z.number(), tokens: z.number() })
    .nullable(),
});

export const improveScan = defineOperation({
  name: "improve.scan",
  description:
    "The improver's look at a project (ADR 0373): whether self-improvement is on, the running trial if any, and the one practice change it would trial next with its evidence (or why none). Reads only; config.trial.start and config.trial.resolve act on it.",
  risk: "read",
  actors: ["self-improve", "human"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    enabled: z.boolean(),
    running: z.array(z.object({ id: z.string(), summary: z.string(), createdAt: z.string() })),
    candidate: z
      .object({
        kind: z.enum(["instructions", "tier"]),
        summary: z.string(),
        evidence: z.record(z.string(), z.unknown()),
        policy: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    baseVersion: z.number(),
    reason: z.string(),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const policy = ctx.scope.policy;
    const baseVersion = versionOf(project.policy_sha) ?? 0;
    const running = await ctx.db
      .selectFrom("core_config_trials")
      .select(["id", "summary", "created_at"])
      .where("project_id", "=", project.id)
      .where("status", "=", "running")
      .execute();
    const view = running.map((r) => ({ id: r.id, summary: r.summary, createdAt: r.created_at }));
    const none = (reason: string) => ({
      enabled: policy?.improve.enabled ?? false,
      running: view,
      candidate: null,
      baseVersion,
      reason,
    });
    if (!policy) return none("no valid config");
    if (!policy.improve.enabled) return none("self-improvement is off");
    if (running.length) return none("a trial is running");
    const week = await ctx.db
      .selectFrom("core_config_trials")
      .select(sql<number>`count(*)`.as("n"))
      .where("project_id", "=", project.id)
      .where("created_at", ">=", daysAgo(ctx.now, 7))
      .executeTakeFirst();
    if ((week?.n ?? 0) >= policy.improve.weeklyCap) {
      return none(`this week's ${policy.improve.weeklyCap} changes are used`);
    }
    const tried = (
      await ctx.db
        .selectFrom("core_config_trials")
        .select("summary")
        .where("project_id", "=", project.id)
        .where("status", "=", "disabled")
        .where("created_at", ">=", daysAgo(ctx.now, RETRY_AFTER_DAYS))
        .execute()
    ).map((t) => t.summary);
    const recent = await recentOutcomes(ctx.db, project.id, { limit: 10 });
    const doc = await currentDoc(ctx, project.policy_sha);
    const candidate = doc ? draftCandidate(doc, policy, recent, tried) : null;
    if (!candidate) {
      return none(
        recent.length < 5
          ? `waiting for more finished work (${recent.length} of 5)`
          : "nothing to change: no repeated failure, and recent work didn't all pass first time",
      );
    }
    return { enabled: true, running: view, candidate, baseVersion, reason: candidate.summary };
  },
});

async function currentDoc(ctx: HandlerContext, sha: string | null) {
  if (!sha) return null;
  const row = await ctx.db
    .selectFrom("core_project_policies")
    .select("raw")
    .where("project_id", "=", ctx.scope.project?.id ?? "")
    .where("sha", "=", sha)
    .executeTakeFirst();
  try {
    return row ? (JSON.parse(row.raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const configTrialStart = defineOperation({
  name: "config.trial.start",
  description:
    "Start a trial of a practice change (ADR 0373): the candidate becomes a config version the project doesn't point at, and the next `trialSize` work items run on it. Refused unless self-improvement is on, no trial is running, the weekly cap allows it, and the change is practice only (an agent's tier or instructions, never anything that loosens).",
  risk: "write",
  actors: ["self-improve"],
  permission: "signed-in",
  input: z.object({
    projectId,
    baseVersion: z.number().int().nonnegative(),
    kind: z.enum(["instructions", "tier"]),
    summary: z.string().min(1).max(200),
    evidence: z.record(z.string(), z.unknown()).default({}),
    policy: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ trialId: z.string(), candidateVersion: z.number() }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const policy = ctx.scope.policy;
    if (!policy?.improve.enabled) throw new OperationError("denied", "self-improvement is off");
    if ((versionOf(project.policy_sha) ?? 0) !== input.baseVersion) {
      throw new OperationError("conflict", "the config moved on since this was drafted");
    }
    const parsed = parseProjectPolicy(JSON.stringify(input.policy));
    if (!parsed.ok)
      throw new OperationError("invalid_input", `candidate isn't valid: ${parsed.error}`);
    const error = practiceOnlyError(policy, parsed.policy, ctx.floor);
    if (error) throw new OperationError("forbidden", error);
    const open = await ctx.db
      .selectFrom("core_config_trials")
      .select("id")
      .where("project_id", "=", project.id)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (open) throw new OperationError("conflict", "a trial is already running");
    const latest = await ctx.db
      .selectFrom("core_project_policies")
      .select(sql<number | null>`max(version)`.as("v"))
      .where("project_id", "=", project.id)
      .executeTakeFirst();
    const version = (latest?.v ?? 0) + 1;
    const id = newId("trial");
    ctx.write(
      ctx.db.insertInto("core_project_policies").values({
        project_id: project.id,
        sha: versionKey(version),
        ref: "trial",
        raw: formatPolicy(input.policy),
        valid: 1,
        error: null,
        received_at: ctx.now,
        version,
        source: "improver",
        created_by: ctx.actor.id,
        note: `Trial: ${input.summary}`,
        parent_version: input.baseVersion,
      }),
    );
    ctx.write(
      ctx.db.insertInto("core_config_trials").values({
        id,
        project_id: project.id,
        base_sha: project.policy_sha ?? "",
        candidate_sha: versionKey(version),
        kind: input.kind,
        summary: input.summary,
        evidence: JSON.stringify(input.evidence),
        target_items: policy.improve.trialSize,
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    ctx.change({
      entity: "config_trial",
      id,
      after: {
        summary: input.summary,
        candidate: versionKey(version),
        items: policy.improve.trialSize,
      },
    });
    return { trialId: id, candidateVersion: version };
  },
});

export const configTrialResolve = defineOperation({
  name: "config.trial.resolve",
  description:
    "Decide a running trial (ADR 0373). The improver's call compares the trial's items with the previous version's: outcomes that hold up promote it (the project moves to the candidate version), worse ones disable it; short of its items it waits (until 14 days). A person may pass `stop` to disable it at once. A trial whose base version is no longer current is disabled: the config moved on.",
  risk: "write",
  actors: ["self-improve", "human"],
  permission: "member",
  input: z.object({ projectId, trialId, stop: z.boolean().default(false) }),
  output: z.object({ status: z.enum(["running", "promoted", "disabled"]), reason: z.string() }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const trial = await ctx.db
      .selectFrom("core_config_trials")
      .selectAll()
      .where("id", "=", input.trialId)
      .where("project_id", "=", project.id)
      .executeTakeFirst();
    if (!trial) throw new OperationError("not_found", "no such trial");
    if (trial.status !== "running") return { status: trial.status, reason: trial.reason ?? "" };
    if (input.stop && ctx.actor.type !== "human") {
      throw new OperationError("forbidden", "only a person stops a trial by hand");
    }
    const decide = (status: "promoted" | "disabled", reason: string, outcome: unknown) => {
      ctx.write(
        ctx.db
          .updateTable("core_config_trials")
          .set({ status, reason, outcome: JSON.stringify(outcome), decided_at: ctx.now })
          .where("id", "=", trial.id)
          .where("status", "=", "running"),
      );
      ctx.guardChanged("decide the trial once");
      ctx.change({
        entity: "config_trial",
        id: trial.id,
        before: { status: "running" },
        after: { status, reason },
      });
      return { status, reason };
    };
    if (input.stop) return decide("disabled", "stopped by a person", null);
    if (project.policy_sha !== trial.base_sha) {
      return decide(
        "disabled",
        "the config moved on: a person saved a new version during the trial",
        null,
      );
    }
    const trialItems = await recentOutcomes(ctx.db, project.id, {
      limit: trial.target_items,
      trialId: trial.id,
    });
    const baseItems = await recentOutcomes(ctx.db, project.id, {
      limit: trial.target_items,
      policySha: trial.base_sha,
    });
    const expired =
      Date.parse(ctx.now) - Date.parse(trial.created_at) > TRIAL_MAX_DAYS * 86_400_000;
    const outcome = evaluateTrial(trialItems, baseItems, trial.target_items, expired);
    if (outcome.decision === "wait") return { status: "running" as const, reason: outcome.reason };
    if (outcome.decision === "disable") return decide("disabled", outcome.reason, outcome);
    // Promote: the project moves to the candidate, if nothing else moved it first.
    ctx.write(
      ctx.db
        .updateTable("core_projects")
        .set({ policy_sha: trial.candidate_sha })
        .where("id", "=", project.id)
        .where("policy_sha", "=", trial.base_sha),
    );
    ctx.guardChanged("the base version is still current");
    ctx.change({
      entity: "project",
      id: project.id,
      before: { policySha: trial.base_sha },
      after: { policySha: trial.candidate_sha, by: "improver", trial: trial.id },
    });
    return decide("promoted", outcome.reason, outcome);
  },
});

export const configTrials = defineOperation({
  name: "config.trials",
  description:
    "A project's trials of practice changes (ADR 0373), newest first: what was tried and why, how far it got, and what decided it. The weekly digest of the factory's own changes.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId, limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({
    trials: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        summary: z.string(),
        status: z.enum(["running", "promoted", "disabled"]),
        evidence: z.record(z.string(), z.unknown()),
        reason: z.string().nullable(),
        outcome: outcomeView.nullable(),
        targetItems: z.number(),
        itemsSoFar: z.number(),
        baseVersion: z.number().nullable(),
        candidateVersion: z.number().nullable(),
        createdAt: z.string(),
        decidedAt: z.string().nullable(),
      }),
    ),
  }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const rows = await ctx.db
      .selectFrom("core_config_trials")
      .selectAll()
      .where("project_id", "=", project.id)
      .orderBy("created_at", "desc")
      .limit(input.limit)
      .execute();
    const counts = rows.length
      ? await ctx.db
          .selectFrom("core_work_items")
          .select(["trial_id", sql<number>`count(*)`.as("n")])
          .where(
            "trial_id",
            "in",
            rows.map((r) => r.id),
          )
          .groupBy("trial_id")
          .execute()
      : [];
    const parse = <T>(s: string | null, d: T): T => {
      try {
        return s ? (JSON.parse(s) as T) : d;
      } catch {
        return d;
      }
    };
    return {
      trials: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        summary: r.summary,
        status: r.status,
        evidence: parse<Record<string, unknown>>(r.evidence, {}),
        reason: r.reason,
        outcome: parse<z.input<typeof outcomeView> | null>(r.outcome, null),
        targetItems: r.target_items,
        itemsSoFar: counts.find((c) => c.trial_id === r.id)?.n ?? 0,
        baseVersion: versionOf(r.base_sha),
        candidateVersion: versionOf(r.candidate_sha),
        createdAt: r.created_at,
        decidedAt: r.decided_at,
      })),
    };
  },
});

/**
 * The running trial a new work item joins, if it has room (ADR 0373): the item then runs on the
 * candidate version. Used by workItem.create.
 */
export async function trialForNewItem(
  ctx: HandlerContext,
  projectIdValue: string,
): Promise<{ id: string; candidateSha: string } | null> {
  const trial = await ctx.db
    .selectFrom("core_config_trials")
    .select(["id", "candidate_sha", "target_items", "base_sha"])
    .where("project_id", "=", projectIdValue)
    .where("status", "=", "running")
    .executeTakeFirst();
  if (!trial || trial.base_sha !== ctx.scope.project?.policy_sha) return null;
  const joined = await ctx.db
    .selectFrom("core_work_items")
    .select(sql<number>`count(*)`.as("n"))
    .where("trial_id", "=", trial.id)
    .executeTakeFirst();
  return (joined?.n ?? 0) < trial.target_items
    ? { id: trial.id, candidateSha: trial.candidate_sha }
    : null;
}

export type { Candidate };
