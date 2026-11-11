// Pieces several operations share: field schemas, work-item creation, stage transitions and the
// GitHub repo reference for a project.
import { json } from "@software-factory/db";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { idPattern, newId, slugify } from "../ids.ts";
import type { HandlerContext, ProjectRow, WorkItemRow } from "../operation.ts";
import type { RepoRef } from "../services.ts";

export const workItemId = z.string().regex(idPattern("workItem"), "a work item id (wi_…)");
export const projectId = z.string().regex(idPattern("project"), "a project id (prj_…)");
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

/** The project's repo, as the GitHub App sees it. Refuses if no App installation covers it. */
export async function repoRef(ctx: HandlerContext, project: ProjectRow): Promise<RepoRef> {
  if (project.installation_record_id) {
    const record = await ctx.db
      .selectFrom("core_github_installations")
      .select(["status", "account_login"])
      .where("id", "=", project.installation_record_id)
      .executeTakeFirst();
    if (record && record.status !== "active") {
      throw new OperationError(
        "unavailable",
        `the GitHub App's installation on ${record.account_login} is ${record.status}: reconnect it in Setup`,
      );
    }
  }
  let installationId = project.github_installation_id;
  if (!installationId) {
    installationId =
      (
        await ctx.db
          .selectFrom("core_organization")
          .select("github_installation_id")
          .where("id", "=", project.org_id)
          .executeTakeFirst()
      )?.github_installation_id ?? null;
  }
  if (!installationId) {
    throw new OperationError(
      "unavailable",
      `no GitHub App installation for ${project.repo_owner}/${project.repo_name}`,
    );
  }
  return { installationId, owner: project.repo_owner, repo: project.repo_name };
}

export function itemBranch(number: number, slug: string): string {
  return `factory/${number}-${slug}`;
}

export interface NewWorkItem {
  project: ProjectRow;
  title: string;
  body: string;
  source: string;
  requesterUserId: string;
  kind?: "change" | "incident";
  parentWorkItemId?: string | null;
  /** Number to use; the caller read `next_number` and the batch guards it. */
  number: number;
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
  const branch = itemBranch(item.number, slug);
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
      workflow_id: id,
      policy_sha: item.project.policy_sha,
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
