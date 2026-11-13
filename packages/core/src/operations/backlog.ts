// The work model's front half (spec 50 part B, ADR 0491): work starts in a backlog, is shaped to
// ready, is released to the factory (queued), and the factory pulls queued items into the pipeline
// by priority, respecting "waits for" links and the project's active limit. Creating an item no
// longer starts its Workflow: the pull does (`startPipeline`).
import { questionDraftSchema } from "@software-factory/runner-contract";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  defineOperation,
  type HandlerContext,
  type ProjectRow,
  type WorkItemRow,
} from "../operation.ts";
import { same } from "../policy/impact.ts";
import { onOrgWorkflow, type ProjectPolicy, specRequired } from "../policy/project-policy.ts";
import {
  generationOf,
  type NeedsInfo,
  needsInfoOf,
  nextGeneration,
  park,
  parkIfNotReady,
  precheck,
  precheckPrompt,
  readinessHint,
  refuseIfParked,
  TRIAGE_PARK_CAP,
} from "../readiness.ts";
import {
  activeKillSwitch,
  adoptedDefinition,
  agentsFrom,
  approverIds,
  loadPolicy,
  MAX_ADOPTED,
  orgConfigAt,
  overrideApprovals,
  parseAdopted,
} from "../scope.ts";
import { childEnded, heldReason, NOT_HELD } from "../splits.ts";
import { workflowImpact } from "../stages/impact.ts";
import type { OrgConfig } from "../stages/org-config.ts";
import {
  resolveProjectWorkflow,
  runsOnToday,
  shapingStagesOf,
  stricterDefinition,
} from "../stages/project-workflow.ts";
import { releaseEvent } from "../workflow-events.ts";
import { trialForNewItem } from "./improve.ts";
import {
  projectId,
  repoRef,
  repositoryId,
  requireProject,
  requireWorkItem,
  STAGE_LABEL,
  STAGE_PHASE,
  STAGES,
  workItemId,
} from "./shared.ts";
import { currentOrgConfig, storedOrgConfig } from "./workflows.ts";

/** States before release: no Workflow instance exists in them, except `shaping` (part C). */
export const PRE_PIPELINE = ["backlog", "shaping", "ready", "queued"] as const;
/** The states a person can put an item in before the pipeline (`workItem.create`, `workItem.move`). */
export const INTAKE_STATES = ["backlog", "ready", "queued"] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];
/** Items in the pipeline: they count against `activeLimit`. */
/** The states a person can still order (workItem.reorder). */
const ORDERABLE = ["backlog", "ready", "queued"] as const;
export const ACTIVE_STATUSES = ["running", "waiting", "paused"] as const;

/** Priority names, in pull order: stored as their index (0 urgent … 3 low). */
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const priority = z.enum(PRIORITIES);
export const priorityOf = (n: number): Priority => PRIORITIES[n] ?? "normal";
export const priorityIndex = (p: Priority): number => PRIORITIES.indexOf(p);

const isPre = (status: string) => (PRE_PIPELINE as readonly string[]).includes(status);

/**
 * Whether an item following `workflow` needs a repository (ADR 0490, 0491): the one place that
 * decides it. Every workflow today runs the skeleton's build, which needs code, so it is always
 * true; a workflow without a code stage (a launch post) would return false.
 */
export function workflowNeedsRepository(
  _policy: Pick<ProjectPolicy, "workflows"> | null,
  _workflow: string | null,
): boolean {
  return true;
}

/**
 * Why `ctx.actor` may not release this item now, or null (ADR 0491). In code, never a prompt:
 * people may always release; anyone else only where the project's config allows agents to.
 */
export function releaseRefusal(
  ctx: Pick<HandlerContext, "actor" | "scope">,
  item: Pick<WorkItemRow, "status" | "repository_id" | "number">,
): OperationError | null {
  if (item.status !== "backlog" && item.status !== "ready") {
    return new OperationError(
      "conflict",
      `work item #${item.number} is ${item.status}: only backlog or ready work can be released`,
    );
  }
  const policy = ctx.scope.policy;
  if (!policy) {
    return new OperationError(
      "unavailable",
      `the project has no valid config (${ctx.scope.policyError}): nothing can be released`,
    );
  }
  if (workflowUnchosen(policy)) {
    return new OperationError(
      "conflict",
      "the project defines workflows but names none for its items: choose the project's workflow in its Settings first (ADR 0492)",
    );
  }
  if (ctx.actor.type !== "human" && !policy.release.agents) {
    return new OperationError(
      "denied",
      "only a person may release work on this project (its config doesn't let agents release)",
    );
  }
  if (workflowNeedsRepository(policy, policy.workflow) && !item.repository_id) {
    const n = ctx.scope.repositories.length;
    return new OperationError(
      "conflict",
      n === 0
        ? `work item #${item.number} needs a repository and its project has none: add one first`
        : `work item #${item.number} needs a repository: choose one of the project's ${n} (workItem.update)`,
    );
  }
  return null;
}

/**
 * What a pull's start must still find true when its batch commits (ADR 0491). The start is one
 * conditional UPDATE, so two pulls can never both take the last slot: D1 runs write batches one at
 * a time, and the second one's count already sees the first one's start.
 */
export interface StartConditions {
  activeLimit: number;
  needsRepository: boolean;
  /**
   * A shaped item whose shaping was checked against this org config version (spec 52, Q4): it starts
   * only while the org is still at it, in the same guarded write, so a change after the check
   * aborts the pull rather than starting delivery unchecked.
   */
  orgVersion?: number;
}

/**
 * Starts an item's pipeline: it becomes `running`, pins the config version (or a running trial's
 * candidate, ADR 0373) and that version's workflow (ADR 0492), gets its intake stage, and its
 * Workflow is created. Guarded: unless the item is still queued (and, for the pull, the project is
 * still under its active limit, the item has its repository and nothing it waits for is undone),
 * the whole batch aborts and nothing starts. The caller's batch is the pull's own (`queue.pull`),
 * or an attached PR's or incident's creation, which start outside the limit.
 */
export function startPipeline(
  ctx: HandlerContext,
  item: {
    id: string;
    number: number;
    shaping_started_at?: string | null;
    /**
     * The item's Workflow instance: its id, unless it was shaped again (spec 52, Q4) or triage
     * parked it (spec 23: `<id>-r2`, …).
     */
    workflow_id?: string | null;
  },
  project: Pick<ProjectRow, "id" | "org_id" | "policy_sha">,
  pin: {
    policy: Pick<ProjectPolicy, "workflow"> | null;
    trial: { id: string; candidateSha: string } | null;
    /** An attached PR follows no workflow: it skips spec and build (spec 05). */
    workflow?: boolean;
  },
  conditions?: StartConditions,
): void {
  const workflow = pin.workflow === false ? null : (pin.policy?.workflow ?? null);
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({
        status: "running",
        status_reason: null,
        pulled_at: ctx.now,
        policy_sha: pin.trial?.candidateSha ?? project.policy_sha,
        // Delivery always runs on the org's current config version (spec 52, Q4): a shaped item's
        // older version decided only whether its shaping still counts, at release.
        org_config_version: (eb) =>
          eb
            .selectFrom("core_organization")
            .select("config_version")
            .where("id", "=", project.org_id),
        trial_id: pin.trial?.id ?? null,
        workflow,
        workflow_reason: workflow ? "the project's workflow" : null,
        updated_at: ctx.now,
      })
      .where("id", "=", item.id)
      .where("status", "=", "queued")
      // Never a plan's child before its parent's plan merged (review of #171).
      .where(NOT_HELD)
      .$if(!!conditions, (q) =>
        q
          .where(
            sql<number>`(SELECT count(*) FROM core_work_items a WHERE a.project_id = ${project.id} AND a.status IN ('running', 'waiting', 'paused') AND a.awaiting_children = 0)`,
            "<",
            conditions?.activeLimit ?? 0,
          )
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("core_work_item_links as l")
                  .innerJoin("core_work_items as t", "t.id", "l.waits_for_id")
                  .select("l.waits_for_id")
                  .where("l.work_item_id", "=", item.id)
                  .where("t.status", "!=", "done"),
              ),
            ),
          )
          .$if(!!conditions?.needsRepository, (q2) => q2.where("repository_id", "is not", null))
          .$if(conditions?.orgVersion !== undefined, (q2) =>
            q2.where(
              (eb) =>
                eb
                  .selectFrom("core_organization")
                  .select("config_version")
                  .where("id", "=", project.org_id),
              "=",
              conditions?.orgVersion ?? -1,
            ),
          ),
      ),
  );
  ctx.guardChanged(`start #${item.number}`);
  if (item.shaping_started_at) {
    // Shaped before release (ADR 0493): its Workflow already ran the shaping stages and waits at
    // `release: wait`. Wake it; delivery reads the version and workflow pinned just now.
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: item.workflow_id ?? item.id,
        type: releaseEvent(item.id),
        payload: {},
      },
    });
    ctx.change({
      entity: "work_item",
      id: item.id,
      before: { status: "queued" },
      after: { status: "running", pulled: true, workflow, shaped: true },
    });
    return;
  }
  ctx.write(
    ctx.db.insertInto("core_stages").values({
      id: newId("stage"),
      work_item_id: item.id,
      stage: "intake",
      attempt: 1,
      status: "done",
      started_at: ctx.now,
      ended_at: ctx.now,
    }),
  );
  ctx.emit({
    kind: "workflow.create",
    // The item's current Workflow generation (spec 23: a triage-parked item starts a new one).
    payload: { instanceId: item.workflow_id ?? item.id, params: { workItemId: item.id } },
  });
  ctx.change({
    entity: "work_item",
    id: item.id,
    before: { status: "queued" },
    after: { status: "running", pulled: true, workflow },
  });
}

/** A queued item as the pull sees it. */
export interface PullCandidate {
  id: string;
  number: number;
  priority: number;
  rank: number;
  released_at: string | null;
  created_at: string;
  repository_id: string | null;
  shaping_started_at: string | null;
}

/** Pull order (ADR 0491): priority, then rank, then release time, then creation. */
export function pullOrder(a: PullCandidate, b: PullCandidate): number {
  return (
    a.priority - b.priority ||
    a.rank - b.rank ||
    (a.released_at ?? "").localeCompare(b.released_at ?? "") ||
    a.created_at.localeCompare(b.created_at)
  );
}

/** For each item, the items it waits for that aren't done (by id), read in one query. */
export async function blockersOf(
  ctx: Pick<HandlerContext, "db">,
  ids: string[],
): Promise<
  Map<string, { id: string; number: number; title: string; status: string; projectId: string }[]>
> {
  const out = new Map<
    string,
    { id: string; number: number; title: string; status: string; projectId: string }[]
  >();
  if (ids.length === 0) return out;
  const rows = await ctx.db
    .selectFrom("core_work_item_links as l")
    .innerJoin("core_work_items as t", "t.id", "l.waits_for_id")
    .select(["l.work_item_id", "t.id", "t.number", "t.title", "t.status", "t.project_id"])
    .where("l.work_item_id", "in", ids)
    .where("t.status", "!=", "done")
    .execute();
  for (const r of rows) {
    const list = out.get(r.work_item_id) ?? [];
    list.push({
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status,
      projectId: r.project_id,
    });
    out.set(r.work_item_id, list);
  }
  return out;
}

/**
 * Asks for a pull of a project after this call commits (ADR 0491): an outbox message the engine
 * delivers right after the commit, as `queue.pull` by the scheduler. Never inside the caller's own
 * batch, so a pull that loses a race can't abort a finish, a cancel or New work.
 */
export function requestPull(ctx: HandlerContext, projectIdValue: string): void {
  ctx.emit({ kind: "queue.pull", payload: { projectId: projectIdValue } });
}

/**
 * After an item ends: a pull of its own project (its slot is free), and, when it is done, of every
 * other project with queued work waiting on it. The cron catches anything this misses.
 */
export async function requestPullsAfterEnd(
  ctx: HandlerContext,
  item: Pick<WorkItemRow, "id" | "project_id">,
  outcome: string,
): Promise<void> {
  requestPull(ctx, item.project_id);
  if (outcome !== "done") return;
  const others = await ctx.db
    .selectFrom("core_work_item_links as l")
    .innerJoin("core_work_items as w", "w.id", "l.work_item_id")
    .select("w.project_id")
    .distinct()
    .where("l.waits_for_id", "=", item.id)
    .where("w.status", "=", "queued")
    .where("w.project_id", "!=", item.project_id)
    .execute();
  for (const o of others) requestPull(ctx, o.project_id);
}

/**
 * The pull for one project (ADR 0491), run only by `queue.pull` in its own batch: while its active
 * items are under `activeLimit`, start the next queued item that has its repository (when its
 * workflow needs one) and whose "waits for" items are all done, by priority, rank, release time.
 * Each start re-checks those conditions in its own write (`startPipeline`), so a race aborts this
 * pull, never another call, and the next pull picks up.
 */
export async function pullQueued(
  ctx: HandlerContext,
  project: ProjectRow,
  policy: ProjectPolicy | null,
): Promise<string[]> {
  if (!policy) return [];
  // A project that defines workflows but names none fails closed (ADR 0492).
  if (workflowUnchosen(policy)) return [];
  if (await activeKillSwitch(ctx.db, project.org_id, project.id)) return [];
  const active = Number(
    (
      await ctx.db
        .selectFrom("core_work_items")
        .select(sql<number>`count(*)`.as("n"))
        .where("project_id", "=", project.id)
        .where("status", "in", [...ACTIVE_STATUSES])
        // A split's parent waiting for its children holds no slot (review of #171).
        .where("awaiting_children", "=", 0)
        .executeTakeFirst()
    )?.n ?? 0,
  );
  let room = policy.activeLimit - active;
  if (room <= 0) return [];
  const queue = (
    await ctx.db
      .selectFrom("core_work_items")
      .select([
        "id",
        "number",
        "priority",
        "rank",
        "released_at",
        "created_at",
        "repository_id",
        "shaping_started_at",
        "workflow_id",
        "org_config_version",
        "released_by",
        "requester_user_id",
      ])
      .where("project_id", "=", project.id)
      .where("status", "=", "queued")
      // A plan's child still held for its parent is never a candidate (review of #171), so it
      // can't trip startPipeline's guard and abort the pull.
      .where(NOT_HELD)
      .execute()
  ).sort(pullOrder);
  const blocked = await blockersOf(
    ctx,
    queue.map((q) => q.id),
  );
  const needsRepository = workflowNeedsRepository(policy, policy.workflow);
  let trial = await trialForNewItem(ctx, project.id);
  let trialRoom = trial ? await trialRoomLeft(ctx, trial.id) : 0;
  // A trial's items run its candidate version, workflow included (ADR 0373, 0492).
  const trialPolicy = trial
    ? (await loadPolicy(ctx.db, { id: project.id, policy_sha: trial.candidateSha })).policy
    : null;
  const started: string[] = [];
  // Spec 52, Q4: a shaped item's shaping is checked again here, against the version delivery will
  // run on. The org's current config is read once; each older version once (by primary key).
  const raw = ctx.scope.rawPolicy;
  const onOrg = !!raw && onOrgWorkflow(raw);
  const current = onOrg ? await currentOrgConfig(ctx.db, project.org_id) : null;
  const older = new Map<number, OrgConfig | null>();
  for (const q of queue) {
    if (room <= 0) break;
    if (blocked.get(q.id)?.length) continue;
    if (needsRepository && !q.repository_id) continue;
    let orgVersion: number | undefined;
    if (q.shaping_started_at && raw && current) {
      const shapedUnder = q.org_config_version;
      if (shapedUnder !== null && shapedUnder !== current.version && !older.has(shapedUnder))
        older.set(shapedUnder, await storedOrgConfig(ctx.db, project.org_id, shapedUnder));
      const flag = shapingFlag(raw, q, current, older.get(shapedUnder ?? -1) ?? null, {
        id: q.released_by ?? q.requester_user_id,
        agent: false,
        now: ctx.now,
      });
      if (flag) {
        // Back to Ready, flagged, for the person who released it: nothing starts.
        flagAtPull(ctx, q, flag, q.released_by ?? q.requester_user_id);
        continue;
      }
      orgVersion = current.version;
    }
    const onTrial = trial && trialRoom > 0 && trialPolicy;
    startPipeline(
      ctx,
      q,
      project,
      { policy: onTrial ? trialPolicy : policy, trial: onTrial ? trial : null },
      {
        activeLimit: policy.activeLimit,
        needsRepository,
        ...(orgVersion !== undefined ? { orgVersion } : {}),
      },
    );
    if (onTrial && --trialRoom === 0) trial = null;
    started.push(q.id);
    room--;
  }
  return started;
}

/**
 * A project whose config defines workflows but names none for its items (ADR 0492): nothing is
 * released or pulled until a person chooses one, rather than items silently running the skeleton
 * without the workflows' gate steps.
 */
export function workflowUnchosen(policy: Pick<ProjectPolicy, "workflows" | "workflow">): boolean {
  return policy.workflows.length > 0 && !policy.workflow;
}

/** How many more items a running trial takes (ADR 0373). */
async function trialRoomLeft(ctx: Pick<HandlerContext, "db">, trialId: string): Promise<number> {
  const trial = await ctx.db
    .selectFrom("core_config_trials")
    .select("target_items")
    .where("id", "=", trialId)
    .executeTakeFirst();
  const joined = await ctx.db
    .selectFrom("core_work_items")
    .select(sql<number>`count(*)`.as("n"))
    .where("trial_id", "=", trialId)
    .executeTakeFirst();
  return Math.max(0, (trial?.target_items ?? 0) - Number(joined?.n ?? 0));
}

/** The rank a new item gets: after everything already in the project (seconds since the epoch). */
export const newRank = (now: string) => Date.parse(now) / 1000;

/** Refuses a waits-for link that crosses orgs, names a missing item, or would make a cycle. */
export async function checkLink(
  ctx: Pick<HandlerContext, "db">,
  item: { id: string | null; org_id: string },
  waitsFor: string,
): Promise<{ id: string; number: number; title: string }> {
  if (item.id === waitsFor) throw new OperationError("conflict", "an item can't wait for itself");
  const target = await ctx.db
    .selectFrom("core_work_items")
    .select(["id", "org_id", "number", "title"])
    .where("id", "=", waitsFor)
    .executeTakeFirst();
  if (!target || target.org_id !== item.org_id) {
    throw new OperationError("not_found", `no work item ${waitsFor} in this org`);
  }
  if (item.id) {
    // A cycle: the item is already reachable from what it would wait for.
    const reach = await sql<{ id: string }>`
      WITH RECURSIVE r(id) AS (
        SELECT waits_for_id FROM core_work_item_links WHERE work_item_id = ${waitsFor}
        UNION
        SELECT l.waits_for_id FROM core_work_item_links l JOIN r ON l.work_item_id = r.id
      )
      SELECT id FROM r WHERE id = ${item.id} LIMIT 1`.execute(ctx.db);
    if (reach.rows.length) {
      throw new OperationError(
        "conflict",
        `#${target.number} already waits for this item: that would be a cycle`,
      );
    }
  }
  return target;
}

function requirePre(w: WorkItemRow, what: string) {
  if (!isPre(w.status)) {
    throw new OperationError(
      "conflict",
      `work item #${w.number} is ${w.status}: ${what} only before its pipeline starts`,
    );
  }
}

/**
 * A shaped item's plan at release (ADR 0493): how old it is and how far the default branch moved
 * since it was written, so the person releasing it sees a stale plan. Refuses when the config in
 * force now requires a plan (by the item's size) that shaping didn't make.
 */
async function shapedPlan(
  ctx: HandlerContext,
  w: WorkItemRow,
): Promise<{ shapedAt: string | null; baseSha: string | null; behindBy: number | null }> {
  const policy = ctx.scope.policy;
  if (policy && w.size && !w.spec_required && specRequired(policy, w.size).required) {
    throw new OperationError(
      "conflict",
      `work item #${w.number} was shaped without a plan, but the config now requires one for ${w.size} work: cancel it and shape it again`,
    );
  }
  let behindBy: number | null = null;
  const repository = ctx.scope.repository;
  if (w.shaped_base_sha && repository) {
    try {
      behindBy = (
        await ctx.services.github.compareCommits(
          await repoRef(ctx, repository),
          w.shaped_base_sha,
          repository.default_branch,
        )
      ).aheadBy;
    } catch {
      behindBy = null;
    }
  }
  return { shapedAt: w.shaped_at, baseSha: w.shaped_base_sha, behindBy };
}

const startedOutput = z.object({
  /** `queued`: the factory pulls it right after this call commits, when there is room. */
  status: z.string(),
  /**
   * A shaped item's plan (ADR 0493): when it was shaped, the default branch's head then, and how
   * many commits the branch has gained since (null when unknown).
   */
  plan: z
    .object({
      shapedAt: z.string().nullable(),
      baseSha: z.string().nullable(),
      behindBy: z.number().nullable(),
    })
    .optional(),
  /**
   * Set when the readiness pre-check parked it in the Backlog instead (spec 23): who it waits on,
   * why, and the questions asked of them. It goes on by itself once they're answered.
   */
  needsInfo: z
    .object({ waitingOn: z.string(), reason: z.string(), questionIds: z.array(z.string()) })
    .optional(),
  /** The readiness pre-check's hint for the person who released it (spec 23): ignorable. */
  hint: z.string().optional(),
  /**
   * Set when it wasn't released because its workflow's shaping stages changed since it was shaped
   * (spec 52, Q4): a person chooses with workItem.releaseChoice.
   */
  releaseFlag: z
    .object({ reason: z.string(), shapedUnder: z.number(), current: z.number() })
    .optional(),
  /** What it waits for that isn't done; empty when nothing holds it. */
  blockedBy: z.array(
    z.object({ id: z.string(), number: z.number(), title: z.string(), status: z.string() }),
  ),
});

/** A shaped item's release flag (spec 52, Q4), on `core_work_items.release_flag` (migration 0285). */
export interface ReleaseFlag {
  /** Why, in a sentence. */
  reason: string;
  /** The org config version the item was shaped under, and the current one. */
  shapedUnder: number;
  current: number;
  /** Who tried to release it, and whether that was an agent. */
  flaggedBy: string;
  byAgent: boolean;
  at: string;
}

export const releaseFlagOf = (raw: string | null | undefined): ReleaseFlag | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReleaseFlag;
  } catch {
    return null;
  }
};

/** The two choices a person has for a flagged item (spec 52, Q4; the owner's answer). */
export const RELEASE_CHOICES = ["reshape", "accept"] as const;

/**
 * Whether a shaped item's shaping still counts under the org's current workflow (spec 52, Q4).
 * Delivery always runs on the current version; the version the item was shaped under decides only
 * this. Null when it counts: not shaped, not on an org workflow, shaped under the current version,
 * or the current version's shaping stages are the same (ids, types, settings with defaults,
 * conditions, agents, in order). Otherwise the flag to set: a person chooses.
 */
async function releaseFlagFor(
  ctx: HandlerContext,
  w: WorkItemRow,
  orgId: string,
): Promise<ReleaseFlag | null> {
  const raw = ctx.scope.rawPolicy;
  if (!w.shaping_started_at || !raw || !onOrgWorkflow(raw)) return null;
  const current = await currentOrgConfig(ctx.db, orgId);
  const shapedUnder = w.org_config_version;
  if (shapedUnder === null || shapedUnder === current.version) return null;
  const then = await storedOrgConfig(ctx.db, orgId, shapedUnder);
  return shapingFlag(raw, w, current, then, {
    id: ctx.actor.id,
    agent: ctx.actor.type !== "human",
    now: ctx.now,
  });
}

/**
 * The pure check (spec 52, Q4): null when an item's finished shaping counts under the org's current
 * version (shaped under it, or the shaping stages are the same in it), else the flag to set.
 */
function shapingFlag(
  raw: ProjectPolicy,
  w: { number: number; org_config_version: number | null; shaping_started_at: string | null },
  current: { version: number; config: OrgConfig },
  then: OrgConfig | null,
  by: { id: string; agent: boolean; now: string },
): ReleaseFlag | null {
  if (!w.shaping_started_at || !onOrgWorkflow(raw)) return null;
  const shapedUnder = w.org_config_version;
  if (shapedUnder === null || shapedUnder === current.version) return null;
  const shaping = (config: OrgConfig | null) => {
    const r = config ? resolveProjectWorkflow(raw, config) : null;
    return r?.ok ? shapingStagesOf(r.value) : null;
  };
  const was = shaping(then);
  if (was !== null && same(was, shaping(current.config))) return null;
  return {
    reason: `#${w.number} was shaped under org config v${shapedUnder}; its workflow's shaping stages changed in v${current.version}. Shape it again under the current workflow, or accept the shaping already done and deliver it under the current workflow.`,
    shapedUnder,
    current: current.version,
    flaggedBy: by.id,
    byAgent: by.agent,
    at: by.now,
  };
}

/** The pull's flag (spec 52, Q4): a queued shaped item goes back to Ready, flagged, unreleased. */
function flagAtPull(
  ctx: HandlerContext,
  q: { id: string; number: number },
  flag: ReleaseFlag,
  chooser: string | null,
) {
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({
        status: "ready",
        released_at: null,
        released_by: null,
        release_flag: JSON.stringify(flag),
        release_flag_user_id: chooser,
        status_reason: "flagged: its workflow's shaping stages changed since it was shaped",
        updated_at: ctx.now,
      })
      .where("id", "=", q.id)
      .where("status", "=", "queued"),
  );
  ctx.change({
    entity: "work_item",
    id: q.id,
    before: { status: "queued" },
    after: { status: "ready", releaseFlag: flag },
  });
  if (chooser)
    ctx.emit({
      kind: "notify",
      payload: {
        event: "workItem.releaseFlagged",
        userId: chooser,
        workItemId: q.id,
        title: `#${q.number} went back to Ready: its workflow's shaping changed before it started`,
        url: `/?item=${q.id}`,
      },
    });
}

/**
 * Flags an item instead of releasing it (spec 52, Q4): the marker on the item, and the person who
 * must choose told. The person who released it; for an agent's release, the item's requester, else
 * the project's first approver. Nothing is released.
 */
async function flagRelease(ctx: HandlerContext, w: WorkItemRow, flag: ReleaseFlag) {
  const chooser = !flag.byAgent
    ? ctx.actor.id
    : (w.requester_user_id ?? (await approverIds(ctx.db, w.org_id, ctx.scope.policy))[0] ?? null);
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({
        release_flag: JSON.stringify(flag),
        release_flag_user_id: chooser,
        status_reason: "flagged: its workflow's shaping stages changed since it was shaped",
        updated_at: ctx.now,
      })
      .where("id", "=", w.id)
      .where("status", "in", ["backlog", "ready"]),
  );
  ctx.change({
    entity: "work_item",
    id: w.id,
    before: { releaseFlag: releaseFlagOf(w.release_flag) },
    after: { releaseFlag: flag },
  });
  if (chooser)
    ctx.emit({
      kind: "notify",
      payload: {
        event: "workItem.releaseFlagged",
        userId: chooser,
        workItemId: w.id,
        title: `#${w.number} needs your choice before it's released: its workflow's shaping changed`,
        url: `/?item=${w.id}`,
      },
    });
  return {
    status: w.status,
    releaseFlag: { reason: flag.reason, shapedUnder: flag.shapedUnder, current: flag.current },
    blockedBy: [],
  };
}

export const workItemRelease = defineOperation({
  name: "workItem.release",
  description:
    "Release a backlog or ready work item to the factory (ADR 0491): it becomes queued, and the factory pulls it into the pipeline (triage → spec gate → build → verify → merge gate) when the project is under its active limit and everything it waits for is done, by priority then rank. A person may always release; an agent, intake or chat only where the project's config sets `release.agents: true`. Refused when the item's workflow needs a repository and it has none.",
  risk: "write",
  actors: ["human", "agent", "intake"],
  permission: "member",
  input: z.object({ workItemId }),
  output: startedOutput,
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const refused = releaseRefusal(ctx, w);
    if (refused) throw refused;
    takeOverParked(ctx, w, "is released");
    // The readiness pre-check (spec 23): an unclear request is parked, not released.
    const parked = w.shaping_started_at ? null : await parkIfNotReady(ctx, w, "queued");
    if (parked) return parkedOutput(parked);
    const hint = w.shaping_started_at ? null : readinessHint(w);
    return { ...(await releaseNow(ctx, w)), ...(hint ? { hint } : {}) };
  },
});

/** What release and shape return when the pre-check parked the item. */
function parkedOutput(m: NeedsInfo) {
  return {
    status: "backlog",
    needsInfo: { waitingOn: m.waitingOn, reason: m.reason, questionIds: m.questionIds },
    blockedBy: [],
  };
}

/** Releases an item (ADR 0491): queued, and the pull runs after this commits. */
/** Whether a split's parent has merged its plan and released its children (spec 24). */
async function parentReleased(ctx: HandlerContext, parentId: string): Promise<boolean> {
  const parent = await ctx.db
    .selectFrom("core_work_items")
    .select(["awaiting_children", "status"])
    .where("id", "=", parentId)
    .executeTakeFirst();
  return parent?.awaiting_children === 1 || parent?.status === "done";
}

export async function releaseNow(ctx: HandlerContext, w: WorkItemRow) {
  // A plan's child is held until its parent's plan has merged (review of #171), by anyone.
  const held = await heldReason(ctx, w);
  if (held) throw new OperationError("conflict", held);
  {
    const project = requireProject(ctx);
    // A shaped item whose workflow's shaping changed isn't released: it is flagged for a person,
    // whoever asked (an agent's release leaves it flagged, with the reason; spec 52, Q4).
    const flag = await releaseFlagFor(ctx, w, project.org_id);
    if (flag) return flagRelease(ctx, w, flag);
    const plan = w.shaping_started_at ? await shapedPlan(ctx, w) : null;
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "queued",
          status_reason: null,
          released_at: ctx.now,
          released_by: ctx.actor.id,
          release_flag: null,
          release_flag_user_id: null,
          updated_at: ctx.now,
        })
        .where("id", "=", w.id)
        .where("status", "in", ["backlog", "ready"]),
    );
    ctx.guardChanged("release");
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: "queued", releasedBy: ctx.actor.id },
    });
    // The pull runs after this commits, in its own batch (it may start this item or not).
    requestPull(ctx, project.id);
    const blocked = (await blockersOf(ctx, [w.id])).get(w.id) ?? [];
    return {
      status: "queued",
      blockedBy: blocked.map(({ projectId: _p, ...b }) => b),
      ...(plan ? { plan } : {}),
    };
  }
}

export const workItemReleaseChoice = defineOperation({
  name: "workItem.releaseChoice",
  description:
    "Decide a work item flagged at release because its workflow's shaping stages changed since it was shaped (spec 52, Q4). `reshape`: shape it again under the current workflow (its shaping stages run again, then it is ready). `accept`: accept the shaping already done and release it, delivered under the current workflow; if the org's workflow changed again since the flag, it isn't released: it is flagged again against the current version (`refused` says so). A person's choice, recorded; never an agent's.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: true,
  // A person's call from the app or the desktop, never a CLI or MCP token an agent might hold.
  desktopDecidable: true,
  input: z.object({ workItemId, choice: z.enum(RELEASE_CHOICES) }),
  output: z.object({
    status: z.string(),
    /** Why `accept` didn't release: the org saved again since the flag, which now names that. */
    refused: z.string().optional(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const flag = releaseFlagOf(w.release_flag);
    if (!flag)
      throw new OperationError("conflict", `work item #${w.number} isn't waiting on that choice`);
    const current = await currentOrgConfig(ctx.db, project.org_id);
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { releaseFlag: flag },
      after: { releaseChoice: input.choice, orgConfigVersion: current.version },
    });
    const cleared = {
      release_flag: null,
      release_flag_user_id: null,
      status_reason: null,
      updated_at: ctx.now,
    };
    if (input.choice === "accept" && current.version !== flag.current) {
      // The org saved again since the flag: the person accepted a difference that is no longer the
      // one there is. Not released; flagged again against the current version, so they see it.
      const again = await releaseFlagFor(ctx, w, project.org_id);
      if (again) {
        const out = await flagRelease(ctx, w, {
          ...again,
          flaggedBy: ctx.actor.id,
          byAgent: false,
        });
        return {
          status: out.status,
          refused: `the org's workflow changed again (v${flag.current} → v${current.version}): look at the new difference and choose again`,
        };
      }
      // Its shaping counts under the current version after all: an ordinary release.
      ctx.write(
        ctx.db
          .updateTable("core_work_items")
          .set(cleared)
          .where("id", "=", w.id)
          .where("release_flag", "is not", null),
      );
      ctx.guardChanged("release choice");
      const out = await releaseNow(ctx, { ...w, ...cleared });
      return { status: out.status };
    }
    if (input.choice === "accept") {
      // The shaping done counts under the current version: release checks against it from now.
      ctx.write(
        ctx.db
          .updateTable("core_work_items")
          .set({ ...cleared, org_config_version: current.version || null })
          .where("id", "=", w.id)
          .where("release_flag", "is not", null),
      );
      ctx.guardChanged("release choice");
      const out = await releaseNow(ctx, {
        ...w,
        ...cleared,
        org_config_version: current.version || null,
      });
      return { status: out.status };
    }
    // Shape it again: the old Workflow, waiting for its release, ends; a new instance runs the
    // current workflow's shaping stages for the same item.
    const workflowId = `${w.id}_r${Date.parse(ctx.now).toString(36)}`;
    ctx.emit({ kind: "workflow.terminate", payload: { instanceId: w.workflow_id } });
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          ...cleared,
          status: "backlog",
          shaping_started_at: null,
          shaped_at: null,
          shaped_base_sha: null,
          workflow_id: workflowId,
        })
        .where("id", "=", w.id)
        .where("release_flag", "is not", null),
    );
    ctx.guardChanged("release choice");
    const out = await shapeNow(ctx, {
      ...w,
      ...cleared,
      status: "backlog",
      shaping_started_at: null,
      shaped_at: null,
      shaped_base_sha: null,
      workflow_id: workflowId,
    });
    return { status: out.status };
  },
});

export const workItemShape = defineOperation({
  name: "workItem.shape",
  description:
    "Shape a backlog or ready work item before releasing it (ADR 0493): its workflow's shaping stages run now, with no commitment to build. With today's engine those are triage and interview planning (the spec stage and its gate, on the light pool). It doesn't count against the active limit. When shaping is done the item is ready, and releasing it later goes straight to delivery (build, verify, the merge gate). Small items need no shaping: release them from the backlog and they shape inside delivery, as before.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({
    status: z.string(),
    /** The readiness pre-check's hint for the person (spec 23): ignorable. */
    hint: z.string().optional(),
    needsInfo: z
      .object({ waitingOn: z.string(), reason: z.string(), questionIds: z.array(z.string()) })
      .optional(),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    if (w.shaping_started_at) {
      throw new OperationError("conflict", `work item #${w.number} is already being shaped`);
    }
    // Shaping has the same preconditions as release, except who may (only a person, for now).
    const refused = releaseRefusal(ctx, w);
    if (refused) throw refused;
    takeOverParked(ctx, w, "goes to shaping");
    const parked = await parkIfNotReady(ctx, w, "shaping");
    if (parked) {
      const { blockedBy: _b, ...out } = parkedOutput(parked);
      return out;
    }
    const hint = readinessHint(w);
    return { ...(await shapeNow(ctx, w)), ...(hint ? { hint } : {}) };
  },
});

/** Starts shaping an item (ADR 0493): its Workflow runs the shaping stages before release. */
export async function shapeNow(ctx: HandlerContext, w: WorkItemRow) {
  // Shaping a plan's child would triage and plan it before its parent's plan merged.
  const held = await heldReason(ctx, w);
  if (held) throw new OperationError("conflict", held);
  {
    const project = requireProject(ctx);
    const policy = ctx.scope.policy;
    if (await activeKillSwitch(ctx.db, project.org_id, project.id)) {
      throw new OperationError("killed", "a kill switch is on: nothing starts shaping");
    }
    const shapingNow = Number(
      (
        await ctx.db
          .selectFrom("core_work_items")
          .select(sql<number>`count(*)`.as("n"))
          .where("project_id", "=", project.id)
          .where("status", "=", "shaping")
          .executeTakeFirst()
      )?.n ?? 0,
    );
    const limit = policy?.shapingLimit ?? 5;
    if (shapingNow >= limit) {
      throw new OperationError(
        "conflict",
        `${shapingNow} items are already shaping on this project (its shaping limit is ${limit}): release or cancel one first`,
      );
    }
    const workflow = policy?.workflow ?? null;
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "shaping",
          status_reason: null,
          shaping_started_at: ctx.now,
          // The version shaping runs under; the pull pins delivery's again at release.
          policy_sha: project.policy_sha,
          org_config_version: (eb) =>
            eb
              .selectFrom("core_organization")
              .select("config_version")
              .where("id", "=", project.org_id),
          workflow,
          workflow_reason: workflow ? "the project's workflow" : null,
          updated_at: ctx.now,
        })
        .where("id", "=", w.id)
        .where("status", "in", ["backlog", "ready"])
        .where("shaping_started_at", "is", null),
    );
    ctx.guardChanged("shape");
    ctx.write(
      ctx.db.insertInto("core_stages").values({
        id: newId("stage"),
        work_item_id: w.id,
        stage: "intake",
        attempt: 1,
        status: "done",
        started_at: ctx.now,
        ended_at: ctx.now,
      }),
    );
    ctx.emit({
      kind: "workflow.create",
      payload: { instanceId: w.workflow_id ?? w.id, params: { workItemId: w.id } },
    });
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: "shaping" },
    });
    return { status: "shaping" };
  }
}

export const workItemShaped = defineOperation({
  name: "workItem.shaped",
  description:
    "The Workflow finished a work item's shaping stages before release (ADR 0493): the item becomes ready and waits for a person to release it. Returns whether it was already released (then delivery goes on at once).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ released: z.boolean(), event: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const event = releaseEvent(w.id);
    if (w.pulled_at) return { released: true, event };
    // What the plan was written against: the default branch's head now. Best effort: a GitHub
    // outage leaves it unknown, and release then can't say how far the branch moved.
    let baseSha: string | null = null;
    const repository = ctx.scope.repository;
    if (repository) {
      try {
        baseSha = await ctx.services.github.getBranchSha(
          await repoRef(ctx, repository),
          repository.default_branch,
        );
      } catch {
        baseSha = null;
      }
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "ready",
          status_reason: "shaped: release it to build",
          shaped_at: ctx.now,
          shaped_base_sha: baseSha,
          updated_at: ctx.now,
        })
        .where("id", "=", w.id)
        .where("status", "=", "shaping"),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: "ready", shaped: true },
    });
    ctx.emit({
      kind: "notify",
      payload: {
        event: "workItem.shaped",
        userId: w.requester_user_id,
        workItemId: w.id,
        title: `Ready to release: ${w.title}`,
        url: `/work/${w.id}`,
      },
    });
    return { released: false, event };
  },
});

export const workItemMove = defineOperation({
  name: "workItem.move",
  description:
    "Move a work item between backlog and ready, or take a queued one back to ready (un-release) before the factory pulls it (ADR 0491). Nothing runs in these states.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, to: z.enum(["backlog", "ready"]) }),
  output: z.object({ status: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (!["backlog", "ready", "queued"].includes(w.status)) {
      throw new OperationError(
        "conflict",
        `work item #${w.number} is ${w.status}: only backlog, ready or queued work can move`,
      );
    }
    // A shaped item's Workflow already ran its shaping stages and waits for the release: it is
    // released or cancelled, not moved back (spec 50 part C).
    if (w.shaping_started_at && input.to === "backlog") {
      throw new OperationError(
        "conflict",
        `work item #${w.number} was shaped: release it, or cancel it`,
      );
    }
    if (w.status === input.to) return { status: w.status };
    if (input.to === "ready") {
      takeOverParked(ctx, w, "moves to Ready");
      // Marking it ready says it's clear enough to build (spec 23): the pre-check runs.
      if (w.status === "backlog" && (await parkIfNotReady(ctx, w, "ready")))
        return { status: "backlog" };
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: input.to,
          ...(w.status === "queued" ? { released_at: null, released_by: null } : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", w.id)
        .where("status", "=", w.status),
    );
    // A pull in between would have started it: then this move is refused, not applied.
    ctx.guardChanged("move");
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: input.to },
    });
    return { status: input.to };
  },
});

export const workItemUpdate = defineOperation({
  name: "workItem.update",
  description:
    "Edit a work item before its pipeline starts (ADR 0491): title, notes, priority, the repository it uses (one of its project's, ADR 0490), size and acceptance criteria while shaping.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z
    .object({
      workItemId,
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(50_000).optional(),
      priority: priority.optional(),
      repositoryId: repositoryId.nullable().optional(),
      size: z.enum(["small", "medium", "large"]).nullable().optional(),
      acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(50).nullable().optional(),
    })
    .refine((i) => Object.keys(i).length > 1, { message: "nothing to change" }),
  output: z.object({ workItemId: z.string() }),
  // The repository named is validated in the handler: scope must not resolve it before the item's.
  scope: async (input) => ({ workItemId: input.workItemId }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    requirePre(w, "it can be edited");
    // A shaped plan is fixed (ADR 0493): delivery builds what was planned. Only its place in the
    // queue can change; anything else means cancelling it and shaping again.
    if (
      w.shaping_started_at &&
      Object.keys(input).some((k) => k !== "workItemId" && k !== "priority")
    ) {
      throw new OperationError(
        "conflict",
        `work item #${w.number} has been shaped: its plan is fixed (only its priority can change); cancel it and capture it again to change it`,
      );
    }
    // Released work keeps its repository: release checked it, and the pull relies on it. Take it
    // back to ready (workItem.move) to change it.
    if (
      input.repositoryId !== undefined &&
      (!["backlog", "ready"].includes(w.status) || w.shaping_started_at)
    ) {
      throw new OperationError(
        "conflict",
        `work item #${w.number} is ${w.status}: its repository changes only in backlog or ready`,
      );
    }
    if (input.repositoryId && !ctx.scope.repositories.some((r) => r.id === input.repositoryId)) {
      throw new OperationError("not_found", "that repository isn't this project's");
    }
    const set = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.priority !== undefined ? { priority: priorityIndex(input.priority) } : {}),
      ...(input.repositoryId !== undefined ? { repository_id: input.repositoryId } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.acceptanceCriteria !== undefined
        ? {
            acceptance_criteria:
              input.acceptanceCriteria === null ? null : JSON.stringify(input.acceptanceCriteria),
          }
        : {}),
    };
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ ...set, updated_at: ctx.now })
        .where("id", "=", w.id)
        .where("status", "in", [...PRE_PIPELINE]),
    );
    ctx.guardChanged("update");
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: Object.fromEntries(
        Object.keys(set).map((k) => [k, (w as Record<string, unknown>)[k]]),
      ),
      after: set,
    });
    // A parked item whose request was edited (spec 23): the pre-check runs again, and it goes on.
    if (input.body !== undefined || input.title !== undefined) {
      await resumeParked(ctx, { ...w, ...set } as WorkItemRow, {
        body: input.body,
        title: input.title,
      });
    }
    return { workItemId: w.id };
  },
});

export const workItemReorder = defineOperation({
  name: "workItem.reorder",
  description:
    "Place a work item just before or just after another of the same project, before either is pulled (ADR 0491). It takes that item's priority, so it lands next to it in pull order.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z
    .object({ workItemId, before: workItemId.optional(), after: workItemId.optional() })
    .refine((i) => (i.before === undefined) !== (i.after === undefined), {
      message: "give before or after",
    }),
  output: z.object({ priority, rank: z.number() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    requirePre(w, "it can be reordered");
    const anchorId = (input.before ?? input.after) as string;
    const anchor = await ctx.db
      .selectFrom("core_work_items")
      .select(["id", "project_id", "priority", "rank", "status"])
      .where("id", "=", anchorId)
      .executeTakeFirst();
    if (!anchor || anchor.project_id !== w.project_id) {
      throw new OperationError("not_found", "no such work item in this project");
    }
    if (anchor.id === w.id) return { priority: priorityOf(w.priority), rank: w.rank };
    // The neighbour on the other side of the anchor, in the same priority.
    const neighbour = await ctx.db
      .selectFrom("core_work_items")
      .select(["id", "rank"])
      .where("project_id", "=", w.project_id)
      .where("priority", "=", anchor.priority)
      .where("status", "in", [...ORDERABLE])
      .where("id", "!=", w.id)
      .where("rank", input.before ? "<" : ">", anchor.rank)
      .orderBy("rank", input.before ? "desc" : "asc")
      .executeTakeFirst();
    let anchorRank = anchor.rank;
    let neighbourRank = neighbour?.rank;
    // Halving the gap runs out of precision after a few dozen moves between the same two items:
    // then renumber the project's ranks 1, 2, 3… in their current order, and place between those.
    if (neighbourRank !== undefined && Math.abs(anchorRank - neighbourRank) < 1e-6) {
      // Only what can still be ordered (backlog, ready, queued), never done or running work.
      // Queued work is included so it keeps its place against the renumbered ranks.
      const all = await ctx.db
        .selectFrom("core_work_items")
        .select(["id", "rank"])
        .where("project_id", "=", w.project_id)
        .where("status", "in", [...ORDERABLE])
        .where("id", "!=", w.id)
        .orderBy("rank")
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const renumbered = new Map(all.map((r, i) => [r.id, i + 1]));
      for (const [id, r] of renumbered) {
        ctx.write(ctx.db.updateTable("core_work_items").set({ rank: r }).where("id", "=", id));
      }
      anchorRank = renumbered.get(anchor.id) ?? anchorRank;
      neighbourRank = neighbour ? renumbered.get(neighbour.id) : undefined;
    }
    const rank =
      neighbourRank === undefined
        ? anchorRank + (input.before ? -1 : 1)
        : (anchorRank + neighbourRank) / 2;
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ priority: anchor.priority, rank, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { priority: w.priority, rank: w.rank },
      after: { priority: anchor.priority, rank },
    });
    return { priority: priorityOf(anchor.priority), rank };
  },
});

export const workItemLink = defineOperation({
  name: "workItem.link",
  description:
    'Say a work item waits for another ("the launch post waits for the feature", ADR 0491): it is not pulled until that item is done. Same org, any project. Refused for an item already in its pipeline, and for a link that would make a cycle.',
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, waitsFor: workItemId }),
  output: z.object({ linked: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    requirePre(w, "what it waits for can change");
    await checkLink(ctx, w, input.waitsFor);
    const already = await ctx.db
      .selectFrom("core_work_item_links")
      .select("work_item_id")
      .where("work_item_id", "=", w.id)
      .where("waits_for_id", "=", input.waitsFor)
      .executeTakeFirst();
    if (already) return { linked: true };
    // The cycle check again, in the insert itself: two links made at once can't close a cycle
    // between them (D1 runs write batches one at a time). A cycle aborts this call.
    ctx.write(
      ctx.d1
        .prepare(
          `INSERT INTO core_work_item_links (work_item_id, waits_for_id, created_at, created_by)
           SELECT ?1, ?2, ?3, ?4
           WHERE NOT EXISTS (
             WITH RECURSIVE r(id) AS (
               SELECT waits_for_id FROM core_work_item_links WHERE work_item_id = ?2
               UNION
               SELECT l.waits_for_id FROM core_work_item_links l JOIN r ON l.work_item_id = r.id
             )
             SELECT 1 FROM r WHERE id = ?1
           )`,
        )
        .bind(w.id, input.waitsFor, ctx.now, ctx.actor.id),
    );
    ctx.guardChanged("waits-for link without a cycle");
    ctx.change({ entity: "work_item_link", id: w.id, after: { waitsFor: input.waitsFor } });
    return { linked: true };
  },
});

export const workItemUnlink = defineOperation({
  name: "workItem.unlink",
  description:
    'Remove a "waits for" link (ADR 0491), for example when the item it waited for was cancelled. A queued item it held is pulled on the next pass.',
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, waitsFor: workItemId }),
  output: z.object({ unlinked: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    requirePre(w, "what it waits for can change");
    ctx.write(
      ctx.db
        .deleteFrom("core_work_item_links")
        .where("work_item_id", "=", w.id)
        .where("waits_for_id", "=", input.waitsFor),
    );
    ctx.change({ entity: "work_item_link", id: w.id, before: { waitsFor: input.waitsFor } });
    // A queued item it held is pulled by the next pass (the cron): this call's delete isn't
    // committed yet, so a pull here would still see the link.
    return { unlinked: true };
  },
});

export const queuePull = defineOperation({
  name: "queue.pull",
  description:
    'The factory pulls queued work on a project into the pipeline (ADR 0491): while it is under its active limit, the next queued item whose "waits for" items are all done (and that has its repository) starts, by priority, then rank, then release time. Run only by the scheduler: after release, create-and-release, finish and cancel commit (through the outbox), and from the engine\'s minute cron. It starts only work that was already released, so it is never a reviewable decision: the scheduler actor may read and write and nothing else.',
  risk: "write",
  actors: ["scheduler"],
  permission: "signed-in",
  input: z.object({ projectId }),
  output: z.object({ started: z.array(z.string()) }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    return { started: await pullQueued(ctx, project, ctx.scope.policy) };
  },
});

const boardItem = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  stage: z.string(),
  /** The stage's phase (ADR 0493): shaping (before release) or delivery. */
  phase: z.enum(["shaping", "delivery"]),
  priority,
  rank: z.number(),
  size: z.string().nullable(),
  repositoryId: z.string().nullable(),
  requesterUserId: z.string(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Spec 24: the item whose plan split this one off; lists show it under its parent. */
  parentWorkItemId: z.string().nullable().optional(),
  /** Spec 24: held until its parent's plan merges, so it can't be released or shaped yet. */
  heldForParent: z.boolean().optional(),
  waitsFor: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      title: z.string(),
      status: z.string(),
      projectId: z.string(),
    }),
  ),
  /**
   * Set when release flagged it (spec 52, Q4): its workflow's shaping stages changed since it was
   * shaped, and a person chooses (workItem.releaseChoice). Absent otherwise.
   */
  releaseFlag: z
    .object({ reason: z.string(), shapedUnder: z.number(), current: z.number() })
    .optional(),
  /** The waits-for items that aren't done: what keeps it from being pulled. */
  blockedBy: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      title: z.string(),
      status: z.string(),
      projectId: z.string(),
    }),
  ),
});

const BOARD_STATES = [
  ...PRE_PIPELINE,
  ...ACTIVE_STATUSES,
  "done",
  "failed",
  "rejected",
  "cancelled",
] as const;

/**
 * An item's phase (ADR 0493, as the owner decided 2026-11-12): **shaping** until it is released
 * (backlog, shaping, ready), **delivery** from release on. A released item in its triage or spec
 * stage is delivering: a small item released from the backlog runs those stages after release.
 */
export function itemPhase(status: string): "shaping" | "delivery" {
  return status === "backlog" || status === "shaping" || status === "ready"
    ? "shaping"
    : "delivery";
}

export const workItemBoard = defineOperation({
  name: "workItem.board",
  description:
    "Work items by state, for one project or across the org (ADR 0491): by default backlog, ready, queued and the active ones, each with priority, rank, repository, what it waits for and what blocks it, in the order the factory would pull them; and counts per project and state (every state, done and cancelled included). Each item's `phase` is shaping before release (backlog, shaping, ready) and delivery from release on (ADR 0493). At most 500 items: compare with the counts to tell a cut list.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({
    orgId: z.string().min(1),
    projectId: projectId.optional(),
    states: z.array(z.enum(BOARD_STATES)).min(1).optional(),
  }),
  output: z.object({
    items: z.array(boardItem),
    counts: z.array(z.object({ projectId: z.string(), status: z.string(), n: z.number() })),
  }),
  // The org is the input's; a projectId is only a filter.
  scope: async (input) => ({ orgId: input.orgId }),
  async handler(input, ctx) {
    const states = input.states ?? [...PRE_PIPELINE, ...ACTIVE_STATUSES];
    let q = ctx.db
      .selectFrom("core_work_items")
      .selectAll()
      // A plan's child held until its parent's plan merges (spec 24, review of #173): a point read
      // of the parent by primary key, only for such a child.
      .select(sql<number>`CASE WHEN ${NOT_HELD} THEN 0 ELSE 1 END`.as("held_for_parent"))
      .where("org_id", "=", input.orgId)
      .where("status", "in", states as never[]);
    if (input.projectId) q = q.where("project_id", "=", input.projectId);
    let c = ctx.db
      .selectFrom("core_work_items")
      .select(["project_id", "status", sql<number>`count(*)`.as("n")])
      .where("org_id", "=", input.orgId)
      .groupBy(["project_id", "status"]);
    if (input.projectId) c = c.where("project_id", "=", input.projectId);
    const [rows, counts] = await Promise.all([
      q
        .orderBy("priority")
        .orderBy("rank")
        .orderBy("released_at")
        .orderBy("created_at")
        .limit(500)
        .execute(),
      c.execute(),
    ]);
    const ids = rows.map((r) => r.id);
    const links = ids.length
      ? await ctx.db
          .selectFrom("core_work_item_links as l")
          .innerJoin("core_work_items as t", "t.id", "l.waits_for_id")
          .select(["l.work_item_id", "t.id", "t.number", "t.title", "t.status", "t.project_id"])
          .where("l.work_item_id", "in", ids)
          .execute()
      : [];
    return {
      items: rows.map((w) => {
        const waitsFor = links
          .filter((l) => l.work_item_id === w.id)
          .map((l) => ({
            id: l.id,
            number: l.number,
            title: l.title,
            status: l.status,
            projectId: l.project_id,
          }));
        return {
          id: w.id,
          projectId: w.project_id,
          number: w.number,
          title: w.title,
          kind: w.kind,
          status: w.status,
          statusReason: w.status_reason,
          stage: w.stage,
          phase: itemPhase(w.status),
          priority: priorityOf(w.priority),
          rank: w.rank,
          size: w.size,
          repositoryId: w.repository_id,
          requesterUserId: w.requester_user_id,
          releasedAt: w.released_at,
          parentWorkItemId: w.source === "planning" ? w.parent_work_item_id : null,
          heldForParent: w.held_for_parent === 1,
          createdAt: w.created_at,
          updatedAt: w.updated_at,
          waitsFor,
          ...(() => {
            const flag = releaseFlagOf(w.release_flag);
            return flag
              ? {
                  releaseFlag: {
                    reason: flag.reason,
                    shapedUnder: flag.shapedUnder,
                    current: flag.current,
                  },
                }
              : {};
          })(),
          blockedBy: waitsFor.filter((x) => x.status !== "done"),
        };
      }),
      counts: counts.map((r) => ({ projectId: r.project_id, status: r.status, n: Number(r.n) })),
    };
  },
});

/** The engine's built-in workflow, which a project runs when its config defines none (ADR 0492). */
export const BUILT_IN_WORKFLOW = { name: "software", label: "Software (built in)" } as const;

export const projectWorkflow = defineOperation({
  name: "project.workflow",
  description:
    "The workflow a project's items follow (ADR 0492) and the stages an item works through, in order (not intake and done, the engine's entry and exit), each with its label and phase (ADR 0493: shaping before release, delivery after). `workflow` is the one the project's config names, the built-in Software workflow when the config defines none, or null when the project can't release work (no valid config, or workflows defined and none named), with the reason. Today every workflow runs the built-in engine's stages.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    projectId: z.string(),
    workflow: z
      .object({
        name: z.string(),
        label: z.string(),
        description: z.string(),
        builtIn: z.boolean(),
      })
      .nullable(),
    /** Why the project can't release work, when `workflow` is null. */
    unavailable: z.string().nullable(),
    stages: z.array(
      z.object({
        stage: z.string(),
        label: z.string(),
        phase: z.enum(["shaping", "delivery"]),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const policy = ctx.scope.policy;
    // Intake and done are the engine's entry and exit, not stages an item works through.
    const stages = STAGES.filter((s) => s !== "intake" && s !== "done").map((stage) => ({
      stage,
      label: STAGE_LABEL[stage],
      phase: STAGE_PHASE[stage],
    }));
    if (!policy) {
      return {
        projectId: project.id,
        workflow: null,
        unavailable: `the project has no valid config (${ctx.scope.policyError ?? "unknown"})`,
        stages,
      };
    }
    if (workflowUnchosen(policy)) {
      return {
        projectId: project.id,
        workflow: null,
        unavailable: "the project defines workflows but names none for its items",
        stages,
      };
    }
    const named = policy.workflow
      ? policy.workflows.find((w) => w.name.toLowerCase() === policy.workflow?.toLowerCase())
      : undefined;
    // On an org workflow the resolved config names it by id (`wf_…`) and carries its name as the
    // description (spec 52 PR (d)): people read the name.
    const org = onOrgWorkflow(ctx.scope.rawPolicy);
    const workflow = named
      ? {
          name: named.name,
          label: org
            ? named.description || named.name
            : named.name[0]?.toUpperCase() + named.name.slice(1),
          description: org ? "" : named.description,
          builtIn: false,
        }
      : {
          ...BUILT_IN_WORKFLOW,
          description: "Triage, spec, build, verify and merge",
          builtIn: true,
        };
    return { projectId: project.id, workflow, unavailable: null, stages };
  },
});

/** For callers that create an item: the links of a new item, checked and queued as writes. */
export async function linkNewItem(
  ctx: HandlerContext,
  item: { id: string; org_id: string },
  waitsFor: string[],
): Promise<void> {
  for (const target of new Set(waitsFor)) {
    await checkLink(ctx, { id: null, org_id: item.org_id }, target);
    ctx.write(
      ctx.db.insertInto("core_work_item_links").values({
        work_item_id: item.id,
        waits_for_id: target,
        created_at: ctx.now,
        created_by: ctx.actor.id,
      }),
    );
  }
}

/**
 * A parked item's next step after a person answers one of its needs-info questions or edits its
 * request (spec 23): once every needs-info question is answered (or the request was edited), the
 * pre-check runs again over the request and the answers. Passing, the marker is cleared and the
 * item goes on to where it was heading (Ready, released, or shaping). Failing, it stays parked and
 * its requester is asked again. Triage's parking (`source: "triage"`) goes on by being released
 * again, so triage re-runs with the answers in its record.
 */
export async function resumeParked(
  ctx: HandlerContext,
  w: WorkItemRow,
  change: { answered?: { id: string; answer: string }; body?: string; title?: string },
): Promise<"resumed" | "waiting" | "parked again" | null> {
  const marker = needsInfoOf(w.needs_info);
  if (!marker) return null;
  // Triage parked it the most times it may: a person moves it on (release), not an answer.
  if (marker.capped) return "waiting";
  const asked = marker.questionIds.length
    ? await ctx.db
        .selectFrom("core_questions")
        .select(["id", "status", "answer"])
        .where("id", "in", marker.questionIds)
        .execute()
    : [];
  const answers = asked.flatMap((q) =>
    q.id === change.answered?.id
      ? [change.answered.answer]
      : q.status === "answered" && q.answer
        ? [q.answer]
        : [],
  );
  const open = asked.filter((q) => q.status === "open" && q.id !== change.answered?.id);
  // An edit to the request counts at once; answers count when all of them are in.
  if (open.length && change.body === undefined && change.title === undefined) return "waiting";
  const item = {
    ...w,
    title: change.title ?? w.title,
    body: change.body ?? w.body,
  };
  // Spec 24: a sibling it waited for ended without merging. The owner starts it without that
  // sibling (the link goes) or cancels it; nothing runs until they say.
  if (marker.source === "split") {
    const answer = change.answered?.answer ?? answers[0] ?? "";
    if (open.length && !change.answered) return "waiting";
    if (/^cancel/i.test(answer.trim())) {
      ctx.write(
        ctx.db
          .updateTable("core_work_items")
          .set({
            status: "cancelled",
            status_reason: `cancelled: ${marker.reason}`,
            needs_info: null,
            closed_at: ctx.now,
            updated_at: ctx.now,
          })
          .where("id", "=", w.id)
          .where("needs_info", "is not", null),
      );
      ctx.guardChanged("the item is still parked");
      ctx.change({ entity: "work_item", id: w.id, after: { status: "cancelled" } });
      await childEnded(ctx, w, "cancelled");
      return "resumed";
    }
    // Started without it: the links to siblings that ended without merging go.
    const ended = await ctx.db
      .selectFrom("core_work_item_links as l")
      .innerJoin("core_work_items as d", "d.id", "l.waits_for_id")
      .select("l.waits_for_id")
      .where("l.work_item_id", "=", w.id)
      .where("d.status", "in", ["failed", "rejected", "cancelled"])
      .execute();
    for (const e of ended) {
      ctx.write(
        ctx.db
          .deleteFrom("core_work_item_links")
          .where("work_item_id", "=", w.id)
          .where("waits_for_id", "=", e.waits_for_id),
      );
    }
  }
  if (marker.source === "precheck") {
    const checked = precheck({
      title: item.title,
      body: item.body,
      parentId: w.parent_work_item_id,
      answers,
    });
    if (!checked.ok) {
      if (open.length) return "waiting";
      park(ctx, w, {
        heading: marker.heading,
        source: "precheck",
        reason: marker.reason,
        missing: checked.missing,
        prompts: [precheckPrompt(checked.missing)],
      });
      return "parked again";
    }
  }
  // The answers become part of the request, so triage and the planner read them.
  const body =
    answers.length && marker.source !== "split"
      ? `${item.body.trimEnd()}\n\n**From ${w.number ? `#${w.number}'s` : "the"} requester:**\n${answers.map((a) => `- ${a}`).join("\n")}`
      : item.body;
  for (const q of open) {
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ status: "withdrawn", note: "the request was edited" })
        .where("id", "=", q.id)
        .where("status", "=", "open"),
    );
  }
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ needs_info: null, status_reason: null, body, updated_at: ctx.now })
      .where("id", "=", w.id)
      .where("needs_info", "is not", null),
  );
  ctx.guardChanged("the item is still parked");
  ctx.change({
    entity: "work_item",
    id: w.id,
    before: { needsInfo: marker },
    after: { needsInfo: null },
  });
  const next = { ...w, body, needs_info: null };
  // A plan's child parked while held, answered after its parent released the others (review of
  // #171): it goes to the queue with them, not back to Ready.
  const released =
    marker.heading === "ready" && w.source === "planning" && w.parent_work_item_id
      ? await parentReleased(ctx, w.parent_work_item_id)
      : false;
  if (marker.heading === "ready" && !released) {
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ status: "ready", updated_at: ctx.now })
        .where("id", "=", w.id)
        .where("status", "=", "backlog"),
    );
  } else if (marker.heading === "queued" || released) {
    await releaseNow(ctx, next);
  } else {
    await shapeNow(ctx, next);
  }
  return "resumed";
}

/**
 * A parked item moved on by hand (spec 23): a person's call is their judgement, so the marker is
 * cleared and its open questions withdrawn; an agent is refused (answer the questions or edit the
 * request, and it goes on by itself).
 */
function takeOverParked(ctx: HandlerContext, w: WorkItemRow, what: string) {
  const marker = needsInfoOf(w.needs_info);
  if (!marker) return;
  if (ctx.actor.type !== "human") refuseIfParked(w, what);
  if (marker.questionIds.length) {
    ctx.write(
      ctx.db
        .updateTable("core_questions")
        .set({ status: "withdrawn", note: "a person moved the item on" })
        .where("id", "in", marker.questionIds)
        .where("status", "=", "open"),
    );
  }
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ needs_info: null, status_reason: null, updated_at: ctx.now })
      .where("id", "=", w.id),
  );
  w.needs_info = null;
}

export const workItemParkForInfo = defineOperation({
  name: "workItem.parkForInfo",
  description:
    "The Workflow parks a work item triage found not actionable (spec 23, ADR 0304): back in the Backlog with a needs-info marker and triage's questions to its requester. Its Workflow ends and it holds no slot. Answering them releases it again (or shapes it again, as it was heading), and triage runs again on a new Workflow with the answers in the request.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    reason: z.string().min(1).max(2_000),
    questions: z.array(questionDraftSchema).min(1).max(5),
  }),
  output: z.object({ status: z.string(), questionIds: z.array(z.string()) }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    // Only the item's own Workflow, in triage, parks it (review of #125): checked here and guarded
    // in the batch, so a stale or foreign instance can't.
    const caller = ctx.origin.workflowId;
    if (w.stage !== "triage" || !caller || w.workflow_id !== caller) {
      throw new OperationError(
        "conflict",
        "only the work item's current Workflow, in triage, can park it",
      );
    }
    ctx.guardExists(
      "the item is still in triage on this Workflow",
      ctx.db
        .selectFrom("core_work_items")
        .select("id")
        .where("id", "=", w.id)
        .where("stage", "=", "triage")
        .where("workflow_id", "=", caller),
    );
    const heading = w.shaping_started_at && !w.pulled_at ? "shaping" : "queued";
    // At the cap a person decides, with everything asked across the cycles (review of #125).
    const generation = generationOf(w.id, w.workflow_id);
    const capped = generation >= TRIAGE_PARK_CAP;
    const earlier = capped
      ? await ctx.db
          .selectFrom("core_questions")
          .select("prompt")
          .where("work_item_id", "=", w.id)
          .where("planning_session_id", "is", null)
          .orderBy("created_at")
          .limit(50)
          .execute()
      : [];
    const marker = park(ctx, w, {
      heading,
      source: "triage",
      reason: capped
        ? `triage parked it ${generation} times; a person decides now. ${input.reason}`
        : input.reason,
      missing: [],
      prompts: input.questions,
      ...(capped
        ? {
            capped: true,
            asked: [...earlier.map((q) => q.prompt), ...input.questions.map((q) => q.prompt)],
          }
        : {}),
    });
    // A fresh start: the next release or shape begins a new Workflow generation, from intake.
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          pulled_at: null,
          shaping_started_at: null,
          released_at: null,
          released_by: null,
          stage: "intake",
          workflow_id: nextGeneration(w.id, w.workflow_id),
          updated_at: ctx.now,
        })
        .where("id", "=", w.id),
    );
    // Its slot is free: the next queued item may start, after this commits.
    requestPull(ctx, w.project_id);
    return { status: "backlog", questionIds: marker.questionIds };
  },
});

/**
 * Spec 52, Q3: a saved org workflow version that only tightens reaches a running item at its next
 * stage boundary. The Workflow calls this at each boundary in delivery (before verify, before the
 * merge gate); the item moves onto the org's current version when the project's workflow resolved
 * under it (overrides and that version's approvals) has no loosening against the version the item
 * pinned. A loosened version never moves a running item. Stages already run don't run again: only
 * the stages ahead of the item use the new version.
 */
export const workItemRepinWorkflow = defineOperation({
  name: "workItem.repinWorkflow",
  description:
    "At a stage boundary, bring a running work item onto its org's current workflow version where it only tightens (spec 52, Q3). A version that only tightens moves the item onto it (`workflow: repinned`); one that tightens some stages and loosens others gives the item only its tightenings, stage by stage, over what it already runs (`workflow: tightened parts adopted`, appended to the item's `org_config_adopted`). A loosening never reaches a running item, and a later version never takes away a tightening the item adopted. At the merge boundary `behind` lists adopted tightenings verify can act on (verify and the checks before it), for the Workflow to verify again; ones at triage, spec or the build are journaled as `passed`. The Workflow calls it.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  // Called at every boundary: an audit row only when the item moved (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.repinned || out.noticed === true },
  input: z.object({
    workItemId,
    /** The boundary's label, for the journal only: the boundary itself is the item's stage. */
    at: z.string().max(40),
  }),
  output: z.object({
    repinned: z.boolean(),
    /** Only some stages' tightenings were adopted (the version also loosens). */
    partial: z.boolean().default(false),
    from: z.number().nullable(),
    to: z.number().nullable(),
    reason: z.string().nullable(),
    /** Tightenings at stages the item has passed (review of #139): it doesn't go back by itself. */
    behind: z.array(z.string()).default([]),
    /** Tightenings it didn't take: the same stage's change also loosens (review of #185). */
    skipped: z.array(z.string()).default([]),
    /** Told the project's approvers what it didn't take (once per version). */
    noticed: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    // Only the item's Workflow moves it between versions (review of #185).
    if (ctx.origin.surface !== "workflow" && ctx.origin.surface !== "test")
      throw new OperationError(
        "forbidden",
        "an item moves between workflow versions only at its own Workflow's stage boundaries",
      );
    const pinned = w.org_config_version;
    const adoptedRaw = w.org_config_adopted;
    const stay = (reason: string) => ({
      repinned: false,
      partial: false,
      from: pinned,
      to: null,
      reason,
      behind: [] as string[],
    });
    if (pinned === null) return stay("the item isn't on an org workflow");
    if (!(ACTIVE_STATUSES as readonly string[]).includes(w.status))
      return stay("the item isn't running");
    const adopted = parseAdopted(adoptedRaw);
    if (!adopted) return stay("the item's adopted versions can't be read");
    // The org's current version: a point read of its row; documents through the per-isolate cache.
    const at = (
      await ctx.db
        .selectFrom("core_organization")
        .select("config_version")
        .where("id", "=", project.org_id)
        .executeTakeFirst()
    )?.config_version;
    if (!at || at <= Math.max(pinned, ...adopted))
      return stay("the item is on the org's current version");
    const raw = (
      await loadPolicy(ctx.db, { id: project.id, policy_sha: w.policy_sha ?? project.policy_sha })
    ).policy;
    if (!raw || !onOrgWorkflow(raw)) return stay("the item's config isn't on an org workflow");
    // What the item runs now: its pinned workflow with every version it adopted folded in, and the
    // newer version, compared stage by stage against that, never the pin alone (review of #185).
    const current = await adoptedDefinition(
      ctx.db,
      project.org_id,
      raw,
      pinned,
      adoptedRaw,
      project.id,
    );
    if (!current.ok) return stay(`the item's workflow can't be resolved: ${current.error}`);
    const now = await orgConfigAt(ctx.db, project.org_id, at);
    if (!now.ok) return stay("an org config version can't be read");
    const nowDef = resolveProjectWorkflow(raw, now.config, {
      kind: "effective",
      approvals: await overrideApprovals(ctx.db, project.id, at),
    });
    if (!nowDef?.ok) return stay("the project's workflow can't be resolved");
    const agents = {
      before: current.agents,
      after: agentsFrom(nowDef.value, [now.config]),
    };
    const impact = workflowImpact(current.def, nowDef.value, agents);
    // At the merge boundary, the stages verify can act on again: verify and the checks between the
    // build and it (review of #185). A tightening of triage, spec or the build itself is behind the
    // item for good: journaled, never re-run.
    // The boundary from the item's own state, never the caller's label (review of #185): at the merge
    // boundary verify has run (the item is still in verify).
    const merge = w.stage === "verify" || w.stage === "merge";
    const split = (
      changes: { path: string; summary: string }[],
      def: { stages: readonly { id: string }[] },
    ) => {
      const build = def.stages.findIndex((s) => s.id === "build");
      const verify = def.stages.findIndex((s) => s.id === "verify");
      const passed = merge ? verify : build;
      const behind: string[] = [];
      const past: string[] = [];
      for (const c of changes) {
        const id = /^stages\.([^.]+)/.exec(c.path)?.[1];
        const k = def.stages.findIndex((s) => s.id === id);
        if (k < 0 || k > passed) continue;
        if (merge && k > build && k <= verify) behind.push(c.summary);
        else past.push(c.summary);
      }
      return { behind, past };
    };
    const loosening = impact.changes.filter((c) => c.class === "loosens");
    let partial = false;
    let tightens = impact.changes.filter((c) => c.class === "tightens");
    let movesOnto: { stages: readonly { id: string }[] } = nowDef.value;
    let nextAdopted: number[] | null = null;
    // Tightenings it won't take, told to the project's approvers once per version (review of #185).
    const notice = async (why: string, skipped: string[]) => {
      const marker = `"noticeFor":${at},`;
      const told = await ctx.db
        .selectFrom("core_audit")
        .select("id")
        .where("work_item_id", "=", w.id)
        .where("operation", "=", "workItem.repinWorkflow")
        .where(sql<boolean>`instr(diff, ${marker}) > 0`)
        .limit(1)
        .executeTakeFirst();
      if (told) return { ...stay(why), skipped };
      ctx.change({
        entity: "work_item",
        id: w.id,
        after: { noticeFor: at, workflow: "not adopted", why, skipped },
      });
      for (const userId of (await approverIds(ctx.db, project.org_id, ctx.scope.policy)).slice(
        0,
        5,
      ))
        ctx.emit({
          kind: "notify",
          payload: {
            event: "workflow.notAdopted",
            userId,
            workItemId: w.id,
            title: `Work item #${w.number} doesn't take v${at} of the org's workflow: ${why}`,
            url: `/?item=${w.id}`,
          },
        });
      return { ...stay(why), skipped, noticed: true };
    };
    let skipped: string[] = [];
    if (loosening.length) {
      // Only the tightened parts, stage by stage (review of #139).
      const stricter = stricterDefinition(current.def, nowDef.value, agents);
      skipped = stricter.skipped.map((c) => c.summary);
      const why = `v${at} loosens against what the item runs: ${loosening.map((c) => c.summary).join(" ")}`;
      if (stricter.adopted.length === 0 || runsOnToday(stricter.def))
        return skipped.length ? notice(why, skipped) : stay(why);
      if (adopted.length >= MAX_ADOPTED)
        return notice(
          `the item already took tightenings from ${adopted.length} later versions, the most it takes: it finishes on what it runs, unless a person stops it`,
          stricter.adopted.map((c) => c.summary),
        );
      partial = true;
      tightens = stricter.adopted;
      movesOnto = stricter.def;
      nextAdopted = [...adopted, at];
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set(
          nextAdopted
            ? { org_config_adopted: JSON.stringify(nextAdopted), updated_at: ctx.now }
            : { org_config_version: at, org_config_adopted: null, updated_at: ctx.now },
        )
        .where("id", "=", w.id)
        .where("org_config_version", "=", pinned)
        .where((eb) =>
          adoptedRaw === null
            ? eb("org_config_adopted", "is", null)
            : eb("org_config_adopted", "=", adoptedRaw),
        ),
    );
    // Exactly this item, at exactly the pin and adoptions it read (review of #139).
    ctx.guardChanged("the item is still at the org version it read");
    const { behind, past } = split(tightens, movesOnto);
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { orgConfigVersion: pinned, orgConfigAdopted: adopted },
      after: {
        workflow: partial ? "tightened parts adopted" : "repinned",
        ...(nextAdopted ? { orgConfigAdopted: nextAdopted } : { orgConfigVersion: at }),
        at: input.at,
        tightens: tightens.map((c) => c.summary),
        ...(behind.length ? { behind } : {}),
        ...(past.length ? { passed: past } : {}),
        // Tightenings in stages it didn't take (the same stage also loosens), for a person to see.
        ...(skipped.length ? { notAdopted: skipped } : {}),
      },
    });
    if (skipped.length)
      for (const userId of (await approverIds(ctx.db, project.org_id, ctx.scope.policy)).slice(
        0,
        5,
      ))
        ctx.emit({
          kind: "notify",
          payload: {
            event: "workflow.notAdopted",
            userId,
            workItemId: w.id,
            title: `Work item #${w.number} took part of v${at} of the org's workflow; not: ${skipped.join(" ")}`,
            url: `/?item=${w.id}`,
          },
        });
    return { repinned: true, partial, from: pinned, to: at, reason: null, behind, skipped };
  },
});
