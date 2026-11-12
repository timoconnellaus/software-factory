// Pieces several operations share: field schemas, work-item creation, stage transitions and the
// GitHub repo reference for a project.
import { json, type WorkItemKind } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { idPattern, newId, slugify } from "../ids.ts";
import type { HandlerContext, ProjectRow, RepositoryRow, WorkItemRow } from "../operation.ts";
import { endPlanningSessions } from "../planning.ts";
import type { RepoRef } from "../services.ts";

export const workItemId = z.string().regex(idPattern("workItem"), "a work item id (wi_…)");
export const projectId = z.string().regex(idPattern("project"), "a project id (prj_…)");
export const repositoryId = z.string().regex(idPattern("repository"), "a repository id (repo_…)");
export const pendingActionId = z
  .string()
  .regex(idPattern("pendingAction"), "a pending action id (pa_…)");
export const jobId = z.string().regex(idPattern("job"), "a job id (job_…)");
export const questionId = z.string().regex(idPattern("question"), "a question id (q_…)");
export const fencingToken = z.number().int().nonnegative();
export const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
export const STAGES = ["intake", "triage", "spec", "build", "verify", "merge", "done"] as const;

/**
 * Each stage's phase (ADR 0493): **shaping** stages run before release (they need a person, hold
 * no build slot and don't count as active), **delivery** stages after it. These are the fixed
 * engine's stages (the Software workflow): triage and interview planning (the spec stage and its
 * gate) shape; everything from build on delivers. Workflow-defined stages will carry their own.
 */
export const STAGE_PHASE: Record<(typeof STAGES)[number], "shaping" | "delivery"> = {
  intake: "shaping",
  triage: "shaping",
  spec: "shaping",
  build: "delivery",
  verify: "delivery",
  merge: "delivery",
  done: "delivery",
};

/** Each stage's name as people read it (the built-in workflow's; ADR 0493's stages). */
export const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  intake: "Intake",
  triage: "Triage",
  spec: "Spec",
  build: "Build",
  verify: "Verify",
  merge: "Merge",
  done: "Done",
};

export function requireWorkItem(ctx: HandlerContext): WorkItemRow {
  const item = ctx.scope.workItem;
  if (!item) throw new OperationError("not_found", "no such work item");
  return item;
}

export function requireProject(ctx: HandlerContext): ProjectRow {
  const project = ctx.scope.project;
  if (!project) throw new OperationError("not_found", "no such project");
  return project;
}

/**
 * The repository the call is about (ADR 0490): the work item's, the one named by `repositoryId`, or
 * the project's only one. Refuses with the reason when there is none, or several and none named.
 */
export function requireRepository(ctx: HandlerContext): RepositoryRow {
  const repository = ctx.scope.repository;
  if (repository) return repository;
  const project = requireProject(ctx);
  const n = ctx.scope.repositories.length;
  if (ctx.scope.workItem && n > 0) {
    throw new OperationError(
      "not_found",
      `work item #${ctx.scope.workItem.number} has no repository yet: choose one of project ${project.name}'s ${n} repositories`,
    );
  }
  throw new OperationError(
    "not_found",
    n === 0
      ? `project ${project.name} has no repository`
      : `project ${project.name} has ${n} repositories: name one (repositoryId)`,
  );
}

/**
 * The repository a work item uses (ADR 0490): its own, else its project's only one (an item created
 * by code from before 0260 may have none recorded). Null when neither applies.
 */
export async function itemRepository(
  db: HandlerContext["db"],
  item: Pick<WorkItemRow, "repository_id" | "project_id">,
): Promise<RepositoryRow | null> {
  const rows = await db
    .selectFrom("core_repositories")
    .selectAll()
    .$if(!!item.repository_id, (q) => q.where("id", "=", item.repository_id ?? ""))
    .$if(!item.repository_id, (q) => q.where("project_id", "=", item.project_id))
    .limit(2)
    .execute();
  if (item.repository_id) return rows[0] ?? null;
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/** A repository's `owner/name`. */
export const repoSlug = (r: Pick<RepositoryRow, "owner" | "name">) => `${r.owner}/${r.name}`;

/** The repository, as the GitHub App sees it. Refuses if no App installation covers it. */
export async function repoRef(ctx: HandlerContext, repository: RepositoryRow): Promise<RepoRef> {
  if (repository.installation_record_id) {
    const record = await ctx.db
      .selectFrom("core_github_installations")
      .select(["status", "account_login"])
      .where("id", "=", repository.installation_record_id)
      .executeTakeFirst();
    if (record && record.status !== "active") {
      throw new OperationError(
        "unavailable",
        `the GitHub App's installation on ${record.account_login} is ${record.status}: reconnect it in Setup`,
      );
    }
  }
  let installationId = repository.github_installation_id;
  if (!installationId) {
    installationId =
      (
        await ctx.db
          .selectFrom("core_organization")
          .select("github_installation_id")
          .where("id", "=", repository.org_id)
          .executeTakeFirst()
      )?.github_installation_id ?? null;
  }
  if (!installationId) {
    throw new OperationError(
      "unavailable",
      `no GitHub App installation for ${repoSlug(repository)}`,
    );
  }
  return { installationId, owner: repository.owner, repo: repository.name };
}

export function itemBranch(number: number, slug: string): string {
  return `factory/${number}-${slug}`;
}

export interface NewWorkItem {
  project: ProjectRow;
  /** The repository it uses (ADR 0490); null when none is chosen yet. */
  repositoryId: string | null;
  title: string;
  body: string;
  source: string;
  requesterUserId: string;
  kind?: WorkItemKind;
  parentWorkItemId?: string | null;
  /**
   * An attached PR (spec 05): its own head branch, number, URL and head SHA. Other items get
   * `factory/<n>-<slug>` and no PR until the Workflow opens one.
   */
  pr?: { branch: string; number: number; url: string; headSha: string };
  /** Number to use; the caller read `next_number` and the batch guards it. */
  number: number;
  /**
   * Where it starts (ADR 0491): `backlog` or `ready` (nothing runs), or `queued` (released; the
   * caller then pulls it, or starts it at once). Its config version and workflow are pinned when
   * its pipeline starts, not here.
   */
  state: "backlog" | "ready" | "queued";
  /** 0 urgent … 3 low (default 2). */
  priority?: number;
  /** Criteria written while shaping. */
  acceptanceCriteria?: string[] | null;
}

/**
 * Queues the writes that create a work item: the item (in `state`), its lease row and the
 * project's number bump (guarded). It doesn't start the pipeline: `startPipeline` / the pull do
 * (ADR 0491).
 */
export function createWorkItem(
  ctx: HandlerContext,
  item: NewWorkItem,
): { id: string; branch: string; number: number; rank: number; created_at: string } {
  const id = newId("workItem");
  const slug = slugify(item.title);
  const branch = item.pr?.branch ?? itemBranch(item.number, slug);
  const rank = Date.parse(ctx.now) / 1000;
  ctx.write(
    ctx.db
      .updateTable("core_projects")
      .set({ next_number: item.number + 1 })
      .where("id", "=", item.project.id)
      .where("next_number", "=", item.number),
  );
  ctx.guardChanged("work item number");
  ctx.write(
    ctx.db.insertInto("core_work_items").values({
      id,
      org_id: item.project.org_id,
      project_id: item.project.id,
      repository_id: item.repositoryId,
      number: item.number,
      slug,
      title: item.title,
      body: item.body,
      kind: item.kind ?? "change",
      requester_user_id: item.requesterUserId,
      source: item.source,
      stage: "intake",
      status: item.state,
      branch,
      head_sha: item.pr?.headSha ?? null,
      pr_number: item.pr?.number ?? null,
      pr_url: item.pr?.url ?? null,
      workflow_id: id,
      policy_sha: null,
      trial_id: null,
      parent_work_item_id: item.parentWorkItemId ?? null,
      priority: item.priority ?? 2,
      rank,
      acceptance_criteria: item.acceptanceCriteria ? JSON.stringify(item.acceptanceCriteria) : null,
      released_at: item.state === "queued" ? ctx.now : null,
      released_by: item.state === "queued" ? ctx.actor.id : null,
      created_at: ctx.now,
      updated_at: ctx.now,
    }),
  );
  ctx.write(ctx.db.insertInto("core_leases").values({ work_item_id: id, fencing_token: 0 }));
  ctx.change({
    entity: "work_item",
    id,
    after: {
      title: item.title,
      source: item.source,
      requester: item.requesterUserId,
      branch,
      status: item.state,
    },
  });
  ctx.subject({ workItemId: id, projectId: item.project.id, orgId: item.project.org_id });
  return { id, branch, number: item.number, rank, created_at: ctx.now };
}

export function setItemStatus(
  ctx: HandlerContext,
  workItemId: string,
  from: readonly string[],
  to: string,
  reason: string | null = null,
) {
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ status: to as never, status_reason: reason, updated_at: ctx.now })
      .where("id", "=", workItemId)
      .where("status", "in", from as never[]),
  );
}

export { json };

/** Why an attached item skips spec and build (spec 05). */
export const ATTACHED_SKIP_REASON = "attached PR: built outside the factory";

/**
 * Queues the writes that cancel a work item: its stages, queued jobs and live runs, its lease (the
 * fencing token is bumped, so a run still going is fenced), its open gates and questions, and the
 * Workflow. The caller has checked who may cancel and that the item is still open.
 */
export function cancelWorkItem(ctx: HandlerContext, w: WorkItemRow, reason: string): void {
  endPlanningSessions(ctx, w.id, `cancelled: ${reason}`);
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ status: "cancelled", status_reason: reason, closed_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", w.id),
  );
  ctx.write(
    ctx.db
      .updateTable("core_stages")
      .set({ status: "cancelled", ended_at: ctx.now, reason })
      .where("work_item_id", "=", w.id)
      .where("status", "=", "active"),
  );
  ctx.write(
    ctx.db
      .updateTable("core_jobs")
      .set({ status: "cancelled", finished_at: ctx.now })
      .where("work_item_id", "=", w.id)
      .where("status", "in", ["queued", "claimed"]),
  );
  ctx.write(
    ctx.db
      .updateTable("core_runs")
      .set({ status: "cancelled", outcome: "cancelled", ended_at: ctx.now })
      .where("work_item_id", "=", w.id)
      .where("status", "in", ["claimed", "preparing", "running", "collecting"]),
  );
  ctx.write(
    ctx.db
      .updateTable("core_leases")
      .set((eb) => ({
        fencing_token: eb("fencing_token", "+", 1),
        holder_kind: null,
        holder_id: null,
        released_at: ctx.now,
      }))
      .where("work_item_id", "=", w.id),
  );
  ctx.writePendingStatus(
    "close",
    ctx.db
      .updateTable("core_pending_actions")
      .set({
        status: "rejected",
        decision: "rejected",
        decided_at: ctx.now,
        decided_by: ctx.actor.id,
        note: "work item cancelled",
      })
      .where("work_item_id", "=", w.id)
      .where("status", "=", "pending"),
  );
  // An approval not yet used dies with the item (spec 53 review): nothing may carry it out after
  // the cancel, whoever holds it (the item's Workflow, or the babysitter's deliverer).
  ctx.write(
    ctx.db
      .updateTable("core_pending_actions")
      .set({
        status: "rejected",
        decision: "withdrawn",
        decided_at: ctx.now,
        note: "withdrawn: the work item was cancelled",
      })
      .where("work_item_id", "=", w.id)
      .where("status", "=", "approved"),
  );
  ctx.write(
    ctx.db
      .updateTable("core_questions")
      .set({ status: "withdrawn" })
      .where("work_item_id", "=", w.id)
      .where("status", "=", "open"),
  );
  ctx.emit({ kind: "workflow.terminate", payload: { instanceId: w.workflow_id } });
  ctx.change({
    entity: "work_item",
    id: w.id,
    before: { status: w.status },
    after: { status: "cancelled", reason },
  });
}

/** A repo as webhooks name it; operations that take one resolve the project from it. */
export const repoName = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});

/** Scope resolver for connector calls: the repository with this name, and its project. */
export async function repositoryForRepo(
  db: HandlerContext["db"],
  repo: { owner: string; name: string },
): Promise<{ projectId: string; repositoryId: string }> {
  const row = await db
    .selectFrom("core_repositories")
    .select(["id", "project_id"])
    .where(sql<string>`lower(owner)`, "=", repo.owner.toLowerCase())
    .where(sql<string>`lower(name)`, "=", repo.name.toLowerCase())
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", `no project for ${repo.owner}/${repo.name}`);
  return { projectId: row.project_id, repositoryId: row.id };
}

/** Scope resolver for connector calls: the project whose repository this is. */
export async function projectForRepo(
  db: HandlerContext["db"],
  repo: { owner: string; name: string },
): Promise<string> {
  return (await repositoryForRepo(db, repo)).projectId;
}
