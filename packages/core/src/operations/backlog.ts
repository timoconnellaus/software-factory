// The work model's front half (spec 50 part B, ADR 0491): work starts in a backlog, is shaped to
// ready, is released to the factory (queued), and the factory pulls queued items into the pipeline
// by priority, respecting "waits for" links and the project's active limit. Creating an item no
// longer starts its Workflow: the pull does (`startPipeline`).
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
import { type ProjectPolicy, specRequired } from "../policy/project-policy.ts";
import { activeKillSwitch, loadPolicy } from "../scope.ts";
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
  item: { id: string; number: number; shaping_started_at?: string | null },
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
        trial_id: pin.trial?.id ?? null,
        workflow,
        workflow_reason: workflow ? "the project's workflow" : null,
        updated_at: ctx.now,
      })
      .where("id", "=", item.id)
      .where("status", "=", "queued")
      .$if(!!conditions, (q) =>
        q
          .where(
            sql<number>`(SELECT count(*) FROM core_work_items a WHERE a.project_id = ${project.id} AND a.status IN ('running', 'waiting', 'paused'))`,
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
          .$if(!!conditions?.needsRepository, (q2) => q2.where("repository_id", "is not", null)),
      ),
  );
  ctx.guardChanged(`start #${item.number}`);
  if (item.shaping_started_at) {
    // Shaped before release (ADR 0493): its Workflow already ran the shaping stages and waits at
    // `release: wait`. Wake it; delivery reads the version and workflow pinned just now.
    ctx.emit({
      kind: "workflow.event",
      payload: { instanceId: item.id, type: releaseEvent(item.id), payload: {} },
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
    payload: { instanceId: item.id, params: { workItemId: item.id } },
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
      ])
      .where("project_id", "=", project.id)
      .where("status", "=", "queued")
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
  for (const q of queue) {
    if (room <= 0) break;
    if (blocked.get(q.id)?.length) continue;
    if (needsRepository && !q.repository_id) continue;
    const onTrial = trial && trialRoom > 0 && trialPolicy;
    startPipeline(
      ctx,
      q,
      project,
      { policy: onTrial ? trialPolicy : policy, trial: onTrial ? trial : null },
      { activeLimit: policy.activeLimit, needsRepository },
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
  /** What it waits for that isn't done; empty when nothing holds it. */
  blockedBy: z.array(
    z.object({ id: z.string(), number: z.number(), title: z.string(), status: z.string() }),
  ),
});

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
    const project = requireProject(ctx);
    const refused = releaseRefusal(ctx, w);
    if (refused) throw refused;
    const plan = w.shaping_started_at ? await shapedPlan(ctx, w) : null;
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "queued",
          status_reason: null,
          released_at: ctx.now,
          released_by: ctx.actor.id,
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
  output: z.object({ status: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    if (w.shaping_started_at) {
      throw new OperationError("conflict", `work item #${w.number} is already being shaped`);
    }
    // Shaping has the same preconditions as release, except who may (only a person, for now).
    const refused = releaseRefusal(ctx, w);
    if (refused) throw refused;
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
      payload: { instanceId: w.id, params: { workItemId: w.id } },
    });
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: "shaping" },
    });
    return { status: "shaping" };
  },
});

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
  waitsFor: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      title: z.string(),
      status: z.string(),
      projectId: z.string(),
    }),
  ),
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
          createdAt: w.created_at,
          updatedAt: w.updated_at,
          waitsFor,
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
    const workflow = named
      ? {
          name: named.name,
          label: named.name[0]?.toUpperCase() + named.name.slice(1),
          description: named.description,
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
