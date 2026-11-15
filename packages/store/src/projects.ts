// An org's projects: a name, a key for item numbers, and the workflow its items move through.
import { readBatch } from "@software-factory/db";
import { sql } from "kysely";
import { flowDb, iso, newId, StoreError } from "./db.ts";
import type { FlowProjectsTable } from "./schema.ts";

/** A project's GitHub repository, reached through one of its org's App installations. */
export interface ProjectRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  /** GitHub's id of the installation that reaches it. */
  installationId: string;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  key: string;
  workflowId: string;
  nextNumber: number;
  createdAt: string;
  /** Null when the project has no repository. */
  repo: ProjectRepo | null;
}

type Row = FlowProjectsTable;

/** The repository columns as a ProjectRepo, or null unless all are set. */
export function repoOf(row: {
  repo_owner: string | null;
  repo_name: string | null;
  repo_default_branch: string | null;
  repo_installation_id: string | null;
}): ProjectRepo | null {
  const { repo_owner, repo_name, repo_default_branch, repo_installation_id } = row;
  if (!repo_owner || !repo_name || !repo_default_branch || !repo_installation_id) return null;
  return {
    owner: repo_owner,
    name: repo_name,
    defaultBranch: repo_default_branch,
    installationId: repo_installation_id,
  };
}

function toProject(row: Row): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    key: row.key,
    workflowId: row.workflow_id,
    nextNumber: row.next_number,
    createdAt: row.created_at,
    repo: repoOf(row),
  };
}

export async function createProject(
  d1: D1Database,
  input: { orgId: string; name: string; key: string; workflowId: string },
): Promise<Project> {
  const row: Row = {
    id: newId("fprj_"),
    org_id: input.orgId,
    name: input.name,
    key: input.key,
    workflow_id: input.workflowId,
    next_number: 1,
    created_at: iso(),
    repo_owner: null,
    repo_name: null,
    repo_default_branch: null,
    repo_installation_id: null,
  };
  await flowDb(d1).insertInto("flow_projects").values(row).execute();
  return toProject(row);
}

export async function getProject(d1: D1Database, id: string): Promise<Project | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toProject(row) : null;
}

/**
 * The org's projects by name, each with `openCount`: its items not resting in a status nobody owns
 * (waiting on something, or stopped with an error). The counts are one grouped read of the partial
 * flow_items_open_idx, which holds only open items.
 */
export async function listProjects(
  d1: D1Database,
  orgId: string,
): Promise<(Project & { openCount: number })[]> {
  const db = flowDb(d1);
  const [rows, counts] = await readBatch(d1, [
    db.selectFrom("flow_projects").selectAll().where("org_id", "=", orgId).orderBy("name"),
    // The predicate is written as the index's WHERE, literally, so SQLite uses the partial index.
    db
      .selectFrom("flow_items")
      .select(["project_id", (eb) => eb.fn.countAll<number>().as("open")])
      .where("org_id", "=", orgId)
      .where(sql<boolean>`(waiting_on <> 'nothing' OR error IS NOT NULL)`)
      .groupBy("project_id"),
  ] as const);
  const open = new Map(counts.map((c) => [c.project_id, Number(c.open)]));
  return rows.map((row) => ({ ...toProject(row), openCount: open.get(row.id) ?? 0 }));
}

/** Points the project at another workflow. Its items keep their status ids. */
export async function setProjectWorkflow(
  d1: D1Database,
  projectId: string,
  workflowId: string,
): Promise<void> {
  const result = await flowDb(d1)
    .updateTable("flow_projects")
    .set({ workflow_id: workflowId })
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new StoreError("not_found", `No project ${projectId}.`);
}

/** Sets the project's repository, or clears it with null. */
export async function setProjectRepo(
  d1: D1Database,
  projectId: string,
  repo: ProjectRepo | null,
): Promise<void> {
  const result = await flowDb(d1)
    .updateTable("flow_projects")
    .set({
      repo_owner: repo?.owner ?? null,
      repo_name: repo?.name ?? null,
      repo_default_branch: repo?.defaultBranch ?? null,
      repo_installation_id: repo?.installationId ?? null,
    })
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new StoreError("not_found", `No project ${projectId}.`);
}

/** An org's GitHub App installation, as the GitHub connect flow recorded it. */
export interface OrgInstallation {
  installationId: string;
  accountLogin: string;
}

/**
 * The org's active GitHub App installations (core_github_installations, written by the GitHub
 * connect flow and kept current by its webhooks), oldest first. Reads its org index; an org has a
 * handful at most.
 */
export async function orgInstallations(d1: D1Database, orgId: string): Promise<OrgInstallation[]> {
  const { results } = await d1
    .prepare(
      "SELECT installation_id, account_login FROM core_github_installations WHERE org_id = ? AND status = 'active' ORDER BY created_at LIMIT 20",
    )
    .bind(orgId)
    .all<{ installation_id: string; account_login: string }>();
  return results.map((r) => ({ installationId: r.installation_id, accountLogin: r.account_login }));
}
