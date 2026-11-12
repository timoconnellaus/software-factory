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
import type { ProjectPolicy } from "../policy/project-policy.ts";
import { activeKillSwitch, loadPolicy } from "../scope.ts";
import { trialForNewItem } from "./improve.ts";
import { projectId, repositoryId, requireProject, requireWorkItem, workItemId } from "./shared.ts";

/** States before the pipeline: no Workflow instance exists in them. `planning` is part C's. */
export const PRE_PIPELINE = ["backlog", "planning", "ready", "queued"] as const;
/** The states a person can put an item in before the pipeline (`workItem.create`, `workItem.move`). */
export const INTAKE_STATES = ["backlog", "ready", "queued"] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];
/** Items in the pipeline: they count against `activeLimit`. */
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
 * Starts an item's pipeline (the pull, ADR 0491): it becomes `running`, pins the project's config
 * version (or a running trial's candidate, ADR 0373) and its workflow (ADR 0492), gets its intake
 * stage, and its Workflow is created. Guarded: if another call pulled it first, the batch aborts.
 */
export function startPipeline(
  ctx: HandlerContext,
  item: { id: string; number: number },
  project: Pick<ProjectRow, "id" | "org_id" | "policy_sha">,
  pin: {
    policy: Pick<ProjectPolicy, "workflow"> | null;
    trial: { id: string; candidateSha: string } | null;
    /** An attached PR follows no workflow: it skips spec and build (spec 05). */
    workflow?: boolean;
  },
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
      .where("status", "=", "queued"),
  );
  ctx.guardChanged(`pull #${item.number}`);
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
  extra: Map<string, string[]> = new Map(),
  /** Items this call is finishing as done: their writes aren't committed yet. */
  done: readonly string[] = [],
): Promise<
  Map<string, { id: string; number: number; title: string; status: string; projectId: string }[]>
> {
  const out = new Map<
    string,
    { id: string; number: number; title: string; status: string; projectId: string }[]
  >();
  if (ids.length === 0) return out;
  const links = await ctx.db
    .selectFrom("core_work_item_links as l")
    .select(["l.work_item_id", "l.waits_for_id"])
    .where("l.work_item_id", "in", ids)
    .execute();
  const pairs = [
    ...links.map((l) => [l.work_item_id, l.waits_for_id] as const),
    ...[...extra].flatMap(([id, targets]) => targets.map((t) => [id, t] as const)),
  ];
  const targets = [...new Set(pairs.map(([, t]) => t))];
  const rows = targets.length
    ? await ctx.db
        .selectFrom("core_work_items")
        .select(["id", "number", "title", "status", "project_id"])
        .where("id", "in", targets)
        .execute()
    : [];
  for (const [id, t] of pairs) {
    const row = rows.find((r) => r.id === t);
    if (!row || row.status === "done" || done.includes(t)) continue;
    const list = out.get(id) ?? [];
    if (!list.some((x) => x.id === t)) {
      list.push({
        id: t,
        number: row.number,
        title: row.title,
        status: row.status,
        projectId: row.project_id,
      });
    }
    out.set(id, list);
  }
  return out;
}

/**
 * The pull for one project (ADR 0491): while its active items are under `activeLimit`, start the
 * next queued item whose "waits for" items are all done. Reads happen before this call's writes
 * commit, so the caller passes what its own batch changes: `extra` queued items it is adding or
 * releasing (and their new links), and `leaving` items it is taking out of the pipeline.
 */
export async function pullQueued(
  ctx: HandlerContext,
  project: ProjectRow,
  policy: ProjectPolicy | null,
  opts: {
    extra?: PullCandidate[];
    extraLinks?: Map<string, string[]>;
    leaving?: string[];
    /** Items this call finishes as done: what waits on them may start. */
    done?: string[];
  } = {},
): Promise<string[]> {
  if (!policy) return [];
  if (await activeKillSwitch(ctx.db, project.org_id, project.id)) return [];
  const leaving = opts.leaving ?? [];
  let activeQ = ctx.db
    .selectFrom("core_work_items")
    .select(sql<number>`count(*)`.as("n"))
    .where("project_id", "=", project.id)
    .where("status", "in", [...ACTIVE_STATUSES]);
  if (leaving.length) activeQ = activeQ.where("id", "not in", leaving);
  const active = Number((await activeQ.executeTakeFirst())?.n ?? 0);
  let room = policy.activeLimit - active;
  if (room <= 0) return [];
  const stored = await ctx.db
    .selectFrom("core_work_items")
    .select(["id", "number", "priority", "rank", "released_at", "created_at"])
    .where("project_id", "=", project.id)
    .where("status", "=", "queued")
    .execute();
  const extra = opts.extra ?? [];
  const queue = [...stored.filter((s) => !extra.some((e) => e.id === s.id)), ...extra].sort(
    pullOrder,
  );
  const blocked = await blockersOf(
    ctx,
    queue.map((q) => q.id),
    opts.extraLinks,
    opts.done,
  );
  let trial = await trialForNewItem(ctx, project.id);
  let trialRoom = trial ? await trialRoomLeft(ctx, trial.id) : 0;
  const started: string[] = [];
  for (const q of queue) {
    if (room <= 0) break;
    if (blocked.get(q.id)?.length) continue;
    startPipeline(ctx, q, project, { policy, trial: trialRoom > 0 ? trial : null });
    if (trial && trialRoom > 0 && --trialRoom === 0) trial = null;
    started.push(q.id);
    room--;
  }
  return started;
}

/**
 * After an item ends: pull its own project (its slot is free) and every other project with queued
 * work waiting on it when it is done (ADR 0491). The cron catches anything this misses.
 */
export async function pullAfterEnd(
  ctx: HandlerContext,
  item: Pick<WorkItemRow, "id" | "project_id">,
  outcome: string,
): Promise<string[]> {
  const done = outcome === "done" ? [item.id] : [];
  const project = ctx.scope.project;
  const started =
    project && project.id === item.project_id
      ? await pullQueued(ctx, project, ctx.scope.policy, { leaving: [item.id], done })
      : [];
  if (!done.length) return started;
  const others = await ctx.db
    .selectFrom("core_work_item_links as l")
    .innerJoin("core_work_items as w", "w.id", "l.work_item_id")
    .innerJoin("core_projects as p", "p.id", "w.project_id")
    .selectAll("p")
    .where("l.waits_for_id", "=", item.id)
    .where("w.status", "=", "queued")
    .where("w.project_id", "!=", item.project_id)
    .groupBy("p.id")
    .execute();
  for (const other of others) {
    const { policy } = await loadPolicy(ctx.db, other);
    started.push(...(await pullQueued(ctx, other, policy, { done })));
  }
  return started;
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

const startedOutput = z.object({
  status: z.string(),
  /** Items this call started (its own, or others it made room for). */
  started: z.array(z.string()),
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
    const started = await pullQueued(ctx, project, ctx.scope.policy, {
      extra: [{ ...w, released_at: ctx.now }],
    });
    const blocked = (await blockersOf(ctx, [w.id])).get(w.id) ?? [];
    return {
      status: started.includes(w.id) ? "running" : "queued",
      started,
      blockedBy: blocked.map(({ projectId: _p, ...b }) => b),
    };
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
      .select("rank")
      .where("project_id", "=", w.project_id)
      .where("priority", "=", anchor.priority)
      .where("id", "!=", w.id)
      .where("rank", input.before ? "<" : ">", anchor.rank)
      .orderBy("rank", input.before ? "desc" : "asc")
      .executeTakeFirst();
    const rank =
      neighbour === undefined
        ? anchor.rank + (input.before ? -1 : 1)
        : (anchor.rank + neighbour.rank) / 2;
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
    ctx.write(
      ctx.db
        .insertInto("core_work_item_links")
        .values({
          work_item_id: w.id,
          waits_for_id: input.waitsFor,
          created_at: ctx.now,
          created_by: ctx.actor.id,
        })
        .onConflict((oc) => oc.doNothing()),
    );
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
    'The factory pulls queued work on a project into the pipeline (ADR 0491): while it is under its active limit, the next queued item whose "waits for" items are all done starts, by priority, then rank, then release time. The engine\'s minute cron runs it for projects with queued work; release, finish and cancel also pull.',
  risk: "write",
  actors: ["agent"],
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

export const workItemBoard = defineOperation({
  name: "workItem.board",
  description:
    "Work items by state, for one project or across the org (ADR 0491): by default backlog, ready, queued and the active ones, each with priority, rank, repository, what it waits for and what blocks it, in the order the factory would pull them; and counts per project and state (every state, done and cancelled included). At most 500 items.",
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
