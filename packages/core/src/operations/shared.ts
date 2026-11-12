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
 * The repository the call is about (ADR 0440): the work item's, the one named by `repositoryId`, or
 * the project's only one. Refuses with the reason when there is none, or several and none named.
 */
export function requireRepository(ctx: HandlerContext): RepositoryRow {
  const repository = ctx.scope.repository;
  if (repository) return repository;
  const project = requireProject(ctx);
  const n = ctx.scope.repositories.length;
  if (ctx.scope.workItem && n > 0) {
    throw new OperationError(
      "conflict",
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
  /** The repository it uses (ADR 0440); null when none is chosen yet. */
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
  /** A running trial it joins (ADR 0373): it then runs on the trial's candidate version. */
  trial?: { id: string; candidateSha: string } | null;
}

/**
 * Queues the writes that create a work item and start its Workflow: the item, its lease row, the
 * intake stage, the project's number bump (guarded) and `workflow.create`.
 */
export function createWorkItem(
  ctx: HandlerContext,
  item: NewWorkItem,
): { id: string; branch: string } {
  const id = newId("workItem");
  const slug = slugify(item.title);
  const branch = item.pr?.branch ?? itemBranch(item.number, slug);
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
      status: "running",
      branch,
      head_sha: item.pr?.headSha ?? null,
      pr_number: item.pr?.number ?? null,
      pr_url: item.pr?.url ?? null,
      workflow_id: id,
      policy_sha: item.trial?.candidateSha ?? item.project.policy_sha,
      trial_id: item.trial?.id ?? null,
      parent_work_item_id: item.parentWorkItemId ?? null,
      created_at: ctx.now,
      updated_at: ctx.now,
    }),
  );
  ctx.write(ctx.db.insertInto("core_leases").values({ work_item_id: id, fencing_token: 0 }));
  ctx.write(
    ctx.db.insertInto("core_stages").values({
      id: newId("stage"),
      work_item_id: id,
      stage: "intake",
      attempt: 1,
      status: "done",
      started_at: ctx.now,
      ended_at: ctx.now,
    }),
  );
  ctx.emit({ kind: "workflow.create", payload: { instanceId: id, params: { workItemId: id } } });
  ctx.change({
    entity: "work_item",
    id,
    after: { title: item.title, source: item.source, requester: item.requesterUserId, branch },
  });
  ctx.subject({ workItemId: id, projectId: item.project.id, orgId: item.project.org_id });
  return { id, branch };
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
  ctx.write(
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
