// Projects, their repositories (ADR 0490), their factory config (versions in the app, ADR 0370)
// and kill switches.
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { idPattern, newId, slugify } from "../ids.ts";
import {
  defineOperation,
  type HandlerContext,
  type ProjectRow,
  type RepositoryRow,
} from "../operation.ts";
import { POLICY_PATH, parseProjectPolicy } from "../policy/project-policy.ts";
import { activeKillSwitch, approverIds, isOrgAdmin, resumeEventType } from "../scope.ts";
import type { FactoryServices, RepoRef } from "../services.ts";
import { formatPolicy, versionOf, writeVersion } from "./config.ts";
import { projectId, repositoryId, requireProject, requireRepository } from "./shared.ts";

const connectionView = z.object({
  /** `missing`: no installation reaches the repo; `suspended`/`deleted`: as GitHub reported. */
  status: z.enum(["connected", "missing", "suspended", "deleted"]),
  /** The GitHub account the App is installed on. */
  account: z.string().nullable(),
  /** Where to change which repositories the App can reach (GitHub's settings page). */
  manageUrl: z.string().nullable(),
});

const policyView = z.object({
  /** `none`: no config yet; `missing`/`invalid`: an imported document that fails closed. */
  state: z.enum(["valid", "invalid", "missing", "none"]),
  error: z.string().nullable(),
  /** The open PR that adds a template policy, when one was opened from Setup. */
  prUrl: z.string().nullable(),
});

/** A repository of a project (ADR 0490) with its connection to GitHub. */
export const repositoryView = z.object({
  id: z.string(),
  projectId: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  /** For admin tools and MCP. The app never shows it (onboarding never asks for ids, ADR 0055). */
  githubInstallationId: z.string().nullable(),
  connection: connectionView,
});
export type RepositoryView = z.input<typeof repositoryView>;

export const projectView = z.object({
  id: z.string(),
  orgId: z.string(),
  factoryId: z.string(),
  name: z.string(),
  slug: z.string(),
  /** The project's first repository; null when it has none (ADR 0490). */
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }).nullable(),
  /** Every repository of the project, oldest first. */
  repositories: z.array(repositoryView),
  policySha: z.string().nullable(),
  /** The current config version (ADR 0370); null before the first one. */
  configVersion: z.number().nullable(),
  /** The first repository's; for admin tools and MCP. The app never shows it (ADR 0055). */
  githubInstallationId: z.string().nullable(),
  /** The first repository's connection; `missing` when the project has no repository. */
  connection: connectionView,
  policy: policyView,
});
export type ProjectView = z.input<typeof projectView>;

const installationId = z.string().regex(/^\d+$/);

/** Set when a repository is saved without a GitHub App installation: why, and what to do. */
const installationWarning = z.string().nullable();

/** GitHub's page for changing which repositories an installation can reach. */
export function manageInstallationUrl(record: {
  installation_id: string;
  account_login: string;
  account_type: string;
}): string {
  return record.account_type === "Organization"
    ? `https://github.com/organizations/${record.account_login}/settings/installations/${record.installation_id}`
    : `https://github.com/settings/installations/${record.installation_id}`;
}

/** Repository rows with their connection state. */
export async function repositoryViews(db: Db, rows: RepositoryRow[]): Promise<RepositoryView[]> {
  if (rows.length === 0) return [];
  const recordIds = rows.map((r) => r.installation_record_id).filter((x): x is string => !!x);
  const installationIds = rows.map((r) => r.github_installation_id).filter((x): x is string => !!x);
  const records =
    recordIds.length || installationIds.length
      ? await db
          .selectFrom("core_github_installations")
          .selectAll()
          .where((eb) =>
            eb.or([
              ...(recordIds.length ? [eb("id", "in", recordIds)] : []),
              ...(installationIds.length ? [eb("installation_id", "in", installationIds)] : []),
            ]),
          )
          .execute()
      : [];
  return rows.map((r) => {
    const record =
      records.find((x) => x.id === r.installation_record_id) ??
      records.find((x) => x.installation_id === r.github_installation_id);
    const connection: z.input<typeof connectionView> = !r.github_installation_id
      ? { status: "missing", account: record?.account_login ?? null, manageUrl: null }
      : {
          status:
            record?.status === "suspended"
              ? "suspended"
              : record?.status === "deleted"
                ? "deleted"
                : "connected",
          account: record?.account_login ?? r.owner,
          manageUrl: record ? manageInstallationUrl(record) : null,
        };
    return {
      id: r.id,
      projectId: r.project_id,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.default_branch,
      githubInstallationId: r.github_installation_id,
      connection,
    };
  });
}

/** Project rows with their repositories, connection and policy state, as project operations return them. */
export async function projectViews(db: Db, rows: ProjectRow[]): Promise<ProjectView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [repoRows, policies] = await Promise.all([
    db
      .selectFrom("core_repositories")
      .selectAll()
      .where("project_id", "in", ids)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
    (async () => {
      const shas = rows.map((r) => r.policy_sha).filter((x): x is string => !!x);
      return shas.length
        ? await db
            .selectFrom("core_project_policies")
            .select(["project_id", "sha", "raw", "valid", "error"])
            .where("project_id", "in", ids)
            .where("sha", "in", shas)
            .execute()
        : [];
    })(),
  ]);
  const repos = await repositoryViews(db, repoRows);
  return rows.map((p) => {
    const mine = repos.filter((r) => r.projectId === p.id);
    const first = mine[0];
    const firstRow = repoRows.find((r) => r.id === first?.id);
    const policy = policies.find((x) => x.project_id === p.id && x.sha === p.policy_sha);
    return {
      id: p.id,
      orgId: p.org_id,
      factoryId: p.factory_id,
      name: p.name,
      slug: p.slug,
      repo: first
        ? { owner: first.owner, name: first.name, defaultBranch: first.defaultBranch }
        : null,
      repositories: mine,
      policySha: p.policy_sha,
      configVersion: versionOf(p.policy_sha),
      githubInstallationId: first?.githubInstallationId ?? null,
      connection: first?.connection ?? { status: "missing", account: null, manageUrl: null },
      policy: {
        state: !policy
          ? "none"
          : policy.valid
            ? "valid"
            : policy.raw === ""
              ? "missing"
              : "invalid",
        error: policy && !policy.valid ? policy.error : null,
        prUrl: firstRow?.policy_pr_url ?? null,
      },
    };
  });
}

/** Asks GitHub, as the App, for its installation on the repo. Never throws: a failure is the reason. */
async function detect(
  services: FactoryServices,
  owner: string,
  repo: string,
): Promise<{ installationId: string; reason: null } | { installationId: null; reason: string }> {
  try {
    return await services.github.findRepoInstallation(owner, repo);
  } catch (err) {
    return { installationId: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

const noInstallation = (reason: string) =>
  `No GitHub App installation: ${reason}. The factory can't read or push this repo until one is connected (Setup → Connect GitHub).`;

/**
 * Gives a project its first config version (ADR 0370): the repository's `.factory/policy.json` at
 * the default branch's head when it has a valid one (source `import`), else the template policy
 * with the person adding the project as approver. No PR: config lives in the app. Also the "import
 * from repo" path (policy.resync), which refuses when the repo has no file to import. Config is per
 * project, so with several repositories the caller names the one to read (ADR 0490).
 */
export async function syncPolicyFromGitHub(
  ctx: HandlerContext,
  project: ProjectRow,
  repository: Pick<RepositoryRow, "default_branch">,
  repo: RepoRef,
  opts: { importOnly?: boolean } = {},
): Promise<{
  applied: boolean;
  valid: boolean;
  error: string | null;
  sha: string;
  imported: boolean;
} | null> {
  const branch = repository.default_branch;
  const head = await ctx.services.github.getBranchSha(repo, branch);
  const content = head ? await ctx.services.github.readFile(repo, POLICY_PATH, head) : null;
  const parsed = content === null ? null : parseProjectPolicy(content);
  if (opts.importOnly) {
    if (!head) return null;
    if (content === null) {
      throw new OperationError("not_found", `${branch} has no ${POLICY_PATH} to import`);
    }
    if (!parsed?.ok) {
      throw new OperationError(
        "invalid_input",
        `${POLICY_PATH} on ${branch} isn't valid: ${parsed?.error ?? "invalid"}`,
      );
    }
  }
  if (parsed?.ok && head) {
    const written = await writeVersion(ctx, project, {
      raw: content ?? "",
      valid: true,
      error: null,
      source: "import",
      note: `Imported from ${POLICY_PATH} at ${head.slice(0, 7)}`,
      ref: `refs/heads/${branch}`,
    });
    return { applied: true, valid: true, error: null, sha: written.sha, imported: true };
  }
  return { ...(await writeTemplate(ctx, project, parsed)), imported: false };
}

/** The template config as the project's next version, the caller as approver. */
async function writeTemplate(
  ctx: HandlerContext,
  project: ProjectRow,
  parsed: ReturnType<typeof parseProjectPolicy> | null = null,
): Promise<{ applied: true; valid: true; error: null; sha: string }> {
  const login = await ctx.db
    .selectFrom("core_user")
    .select("github_login")
    .where("id", "=", ctx.actor.id)
    .executeTakeFirst();
  const written = await writeVersion(ctx, project, {
    raw: templatePolicy(login?.github_login ?? null),
    valid: true,
    error: null,
    source: "app",
    note:
      parsed && !parsed.ok
        ? `Template policy (the repo's ${POLICY_PATH} wasn't valid: ${parsed.error})`
        : "Template policy",
  });
  return { applied: true, valid: true, error: null, sha: written.sha };
}

/** The config a new project starts from: Balanced, the person adding it as approver. */
export function templatePolicy(approverLogin: string | null): string {
  return formatPolicy({
    version: 1,
    autonomyPolicy: "balanced",
    spec: { requiredFrom: "medium" },
    timeouts: { gateHours: 72, questionHours: 48 },
    wipLimit: 5,
    retryLimit: 2,
    approvers: approverLogin ? [approverLogin] : [],
    ...(approverLogin ? { backupOwner: approverLogin } : {}),
  });
}

/** The org's factory, created on first use. */
async function ensureFactory(ctx: HandlerContext, orgId: string): Promise<string> {
  const factory = await ctx.db
    .selectFrom("core_factories")
    .select("id")
    .where("org_id", "=", orgId)
    .orderBy("created_at")
    .executeTakeFirst();
  if (factory) return factory.id;
  const id = newId("factory");
  ctx.write(
    ctx.db.insertInto("core_factories").values({
      id,
      org_id: orgId,
      name: "Default",
      created_at: ctx.now,
      created_by: ctx.actor.id,
    }),
  );
  return id;
}

/**
 * Checks a GitHub repository can become one of the org's repositories (ADR 0055, 0490): the
 * installation record is the org's and active, GitHub reaches the repo through it now, and it isn't
 * already a repository anywhere. Returns the record and GitHub's repo.
 */
async function reachableRepo(
  ctx: HandlerContext,
  orgId: string,
  installationRecordId: string,
  repoIdValue: number,
) {
  const record = await ctx.db
    .selectFrom("core_github_installations")
    .selectAll()
    .where("id", "=", installationRecordId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!record) {
    throw new OperationError("not_found", "that GitHub connection isn't this org's");
  }
  if (record.status !== "active") {
    throw new OperationError(
      "unavailable",
      `the GitHub App's installation on ${record.account_login} is ${record.status}: reconnect it first`,
    );
  }
  // Only GitHub's answer counts: the repo must be reachable through this installation now.
  const repo = await ctx.services.github.getInstallationRepo(record.installation_id, repoIdValue);
  if (!repo) {
    throw new OperationError(
      "unavailable",
      `the GitHub App's installation on ${record.account_login} can't reach that repository. Add it under "Manage repositories on GitHub", then pick it again.`,
    );
  }
  const taken = await ctx.db
    .selectFrom("core_repositories")
    .select(["id", "org_id"])
    .where(sql<string>`lower(owner)`, "=", repo.owner.toLowerCase())
    .where(sql<string>`lower(name)`, "=", repo.name.toLowerCase())
    .executeTakeFirst();
  if (taken) {
    throw new OperationError(
      "conflict",
      `${repo.owner}/${repo.name} is already a project${taken.org_id === orgId ? "" : " in another org"}`,
    );
  }
  return { record, repo };
}

/** Queues the write that adds a repository to a project, and journals it. */
function insertRepository(
  ctx: HandlerContext,
  project: Pick<ProjectRow, "id" | "org_id">,
  record: { id: string; installation_id: string },
  repo: { id: number; owner: string; name: string; defaultBranch: string },
): RepositoryRow {
  const row: RepositoryRow = {
    id: newId("repository"),
    org_id: project.org_id,
    project_id: project.id,
    owner: repo.owner,
    name: repo.name,
    default_branch: repo.defaultBranch,
    github_installation_id: record.installation_id,
    installation_record_id: record.id,
    github_repo_id: repo.id,
    policy_pr_url: null,
    created_at: ctx.now,
    created_by: ctx.actor.id,
  };
  ctx.write(ctx.db.insertInto("core_repositories").values(row));
  ctx.change({
    entity: "repository",
    id: row.id,
    after: {
      project: project.id,
      repo: `${repo.owner}/${repo.name}`,
      repoId: repo.id,
      installation: record.id,
    },
  });
  return row;
}

export const projectCreate = defineOperation({
  name: "project.create",
  description:
    "Add a project (ADR 0490). With `installationRecordId` and `repoId` (pick them from github.repos; ADR 0055) the project gets that GitHub repository as its first one: refused, saving nothing, when the installation isn't the org's, isn't active, or can't reach the repo, and its `.factory/policy.json` is imported from the default branch when valid. Without them the project has no repository (a Marketing project, say) and starts from the template config. Needs an org owner or admin.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z
    .object({
      orgId: z.string().min(1),
      /** The org's installation record (`ghi_…`) from github.repos. */
      installationRecordId: z.string().regex(idPattern("githubInstallation")).optional(),
      /** GitHub's repository id, from github.repos. */
      repoId: z.number().int().positive().optional(),
      /** Defaults to the repo's name. Needed for a project with no repository. */
      name: z.string().min(1).max(100).optional(),
    })
    // Strict: a repository is named only by GitHub's ids, never by free text (ADR 0055).
    .strict()
    .refine((i) => (i.installationRecordId === undefined) === (i.repoId === undefined), {
      message: "give installationRecordId and repoId together, or neither",
    })
    .refine((i) => i.repoId !== undefined || i.name !== undefined, {
      message: "a project with no repository needs a name",
    }),
  output: projectView,
  async handler(input, ctx) {
    const org = await ctx.db
      .selectFrom("core_organization")
      .select("id")
      .where("id", "=", input.orgId)
      .executeTakeFirst();
    if (!org) throw new OperationError("not_found", "no such org");
    const found =
      input.installationRecordId && input.repoId
        ? await reachableRepo(ctx, input.orgId, input.installationRecordId, input.repoId)
        : null;
    const factoryId = await ensureFactory(ctx, input.orgId);
    const name = input.name ?? found?.repo.name ?? "Project";
    const slugs = new Set(
      (
        await ctx.db
          .selectFrom("core_projects")
          .select("slug")
          .where("org_id", "=", input.orgId)
          .execute()
      ).map((r) => r.slug),
    );
    let slug = slugify(name);
    for (let i = 2; slugs.has(slug); i++) slug = `${slugify(name)}-${i}`;
    const id = newId("project");
    const row: ProjectRow = {
      id,
      org_id: input.orgId,
      factory_id: factoryId,
      name,
      slug,
      policy_sha: null,
      next_number: 1,
      created_at: ctx.now,
      created_by: ctx.actor.id,
      // The deprecated mirror for code deployed before 0260 (unique: a project with no repository
      // writes its own id). Nothing reads it; a later migration drops it.
      repo_owner: found?.repo.owner ?? "",
      repo_name: found?.repo.name ?? id,
    };
    ctx.write(ctx.db.insertInto("core_projects").values(row));
    ctx.change({ entity: "project", id: row.id, after: { name } });
    ctx.subject({ projectId: row.id, orgId: input.orgId });
    const repository = found ? insertRepository(ctx, row, found.record, found.repo) : null;
    // The policy, read now through the App, in the same batch: no "Sync" step for people. A
    // project with no repository starts from the template.
    const synced =
      found && repository
        ? await syncPolicyFromGitHub(ctx, row, repository, {
            installationId: found.record.installation_id,
            owner: found.repo.owner,
            repo: found.repo.name,
          })
        : await writeTemplate(ctx, row);
    const repoViews: RepositoryView[] =
      found && repository
        ? [
            {
              id: repository.id,
              projectId: row.id,
              owner: repository.owner,
              name: repository.name,
              defaultBranch: repository.default_branch,
              githubInstallationId: repository.github_installation_id,
              connection: {
                status: "connected" as const,
                account: found.record.account_login,
                manageUrl: manageInstallationUrl(found.record),
              },
            },
          ]
        : [];
    const first = repoViews[0];
    return {
      id: row.id,
      orgId: row.org_id,
      factoryId,
      name,
      slug: row.slug,
      repo: first
        ? { owner: first.owner, name: first.name, defaultBranch: first.defaultBranch }
        : null,
      repositories: repoViews,
      policySha: synced?.sha ?? null,
      configVersion: versionOf(synced?.sha ?? null),
      githubInstallationId: first?.githubInstallationId ?? null,
      connection: first?.connection ?? {
        status: "missing" as const,
        account: null,
        manageUrl: null,
      },
      policy: { state: "valid" as const, error: null, prUrl: null },
    };
  },
});

export const repositoryAdd = defineOperation({
  name: "repository.add",
  description:
    "Add a GitHub repository to a project with none (ADR 0490): pick it from github.repos. The same checks as project.create (the org's installation, active, reaching the repo, not already a repository anywhere). A project has at most one repository until protection is tracked per repository: a second one would be unprotected while Setup showed green, so it is refused. The project's config is unchanged: it is per project. Needs an org owner or admin.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    projectId,
    installationRecordId: z.string().regex(idPattern("githubInstallation")),
    repoId: z.number().int().positive(),
  }),
  output: repositoryView,
  // Scoped to the org: like project.update, it must work before the project has a valid config.
  scope: async (input, db) => {
    const p = await db
      .selectFrom("core_projects")
      .select("org_id")
      .where("id", "=", input.projectId)
      .executeTakeFirst();
    return { orgId: p?.org_id ?? null };
  },
  async handler(input, ctx) {
    const project = await ctx.db
      .selectFrom("core_projects")
      .selectAll()
      .where("id", "=", input.projectId)
      .executeTakeFirst();
    if (!project || project.org_id !== ctx.scope.orgId) {
      throw new OperationError("not_found", "no such project");
    }
    // One repository per project for now (ADR 0490 §8): the default-branch protection verdict, the
    // check that holds builds on red and the daily re-check are still per project, so a second
    // repository's main would be unguarded with Setup green.
    const existing = await ctx.db
      .selectFrom("core_repositories")
      .select(["owner", "name"])
      .where("project_id", "=", project.id)
      .executeTakeFirst();
    if (existing) {
      throw new OperationError(
        "conflict",
        `project ${project.name} already has ${existing.owner}/${existing.name}: a second repository waits until protection is tracked per repository (spec 50 follow-up)`,
      );
    }
    const { record, repo } = await reachableRepo(
      ctx,
      project.org_id,
      input.installationRecordId,
      input.repoId,
    );
    const row = insertRepository(ctx, project, record, repo);
    ctx.subject({ projectId: project.id, orgId: project.org_id });
    return {
      id: row.id,
      projectId: project.id,
      owner: row.owner,
      name: row.name,
      defaultBranch: row.default_branch,
      githubInstallationId: row.github_installation_id,
      connection: {
        status: "connected" as const,
        account: record.account_login,
        manageUrl: manageInstallationUrl(record),
      },
    };
  },
});

export const repositoryList = defineOperation({
  name: "repository.list",
  description:
    "The repositories in an org (ADR 0490), or of one project, with their connection to GitHub.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1), projectId: projectId.optional() }),
  output: z.object({ repositories: z.array(repositoryView) }),
  // The org is the input's; a projectId is only a filter, so it must not decide the scope.
  scope: async (input) => ({ orgId: input.orgId }),
  async handler(input, ctx) {
    let q = ctx.db.selectFrom("core_repositories").selectAll().where("org_id", "=", input.orgId);
    if (input.projectId) q = q.where("project_id", "=", input.projectId);
    const rows = await q.orderBy("created_at").orderBy("id").execute();
    return { repositories: await repositoryViews(ctx.db, rows) };
  },
});

const repositoryFix = {
  githubInstallationId: installationId.nullable().optional(),
  detectInstallation: z.boolean().optional(),
  defaultBranch: z.string().min(1).max(100).optional(),
};
type RepositoryFix = {
  githubInstallationId?: string | null | undefined;
  detectInstallation?: boolean | undefined;
  defaultBranch?: string | undefined;
};
const fixRefinements = <T extends z.ZodType<RepositoryFix>>(schema: T) =>
  schema
    .refine((i) => !(i.detectInstallation && i.githubInstallationId !== undefined), {
      message: "give githubInstallationId or detectInstallation, not both",
    })
    .refine(
      (i) =>
        i.detectInstallation ||
        i.githubInstallationId !== undefined ||
        i.defaultBranch !== undefined,
      { message: "nothing to change" },
    );

/** Scoped to the org, not the project: this is how a repository gets connected (see below). */
async function orgOfRepositoryTarget(
  db: Db,
  input: { projectId?: string; repositoryId?: string | undefined },
) {
  if (input.repositoryId) {
    const r = await db
      .selectFrom("core_repositories")
      .select(["org_id", "project_id"])
      .where("id", "=", input.repositoryId)
      .executeTakeFirst();
    return { orgId: r?.org_id ?? null };
  }
  const p = input.projectId
    ? await db
        .selectFrom("core_projects")
        .select("org_id")
        .where("id", "=", input.projectId)
        .executeTakeFirst()
    : undefined;
  return { orgId: p?.org_id ?? null };
}

/** The repository a fix is for: the one named, else the project's only one. */
async function fixTarget(
  ctx: HandlerContext,
  input: { projectId?: string; repositoryId?: string | undefined },
): Promise<RepositoryRow> {
  let q = ctx.db.selectFrom("core_repositories").selectAll().where("org_id", "=", ctx.scope.orgId);
  if (input.repositoryId) q = q.where("id", "=", input.repositoryId);
  if (input.projectId) q = q.where("project_id", "=", input.projectId);
  const rows = await q.limit(2).execute();
  const [row] = rows;
  if (!row) {
    throw new OperationError(
      "not_found",
      input.repositoryId ? "no such repository" : "no such project, or it has no repository",
    );
  }
  if (rows.length > 1) {
    throw new OperationError(
      "not_found",
      "this project has several repositories: name one (repositoryId)",
    );
  }
  return row;
}

/** Applies an admin fix to a repository's GitHub connection; returns the row as it will be. */
async function applyRepositoryFix(
  ctx: HandlerContext,
  repository: RepositoryRow,
  input: RepositoryFix,
): Promise<RepositoryRow> {
  const next = { ...repository };
  if (input.detectInstallation) {
    const found = await detect(ctx.services, repository.owner, repository.name);
    if (!found.installationId)
      throw new OperationError("not_found", noInstallation(found.reason ?? "not found"));
    next.github_installation_id = found.installationId;
  } else if (input.githubInstallationId !== undefined) {
    next.github_installation_id = input.githubInstallationId;
  }
  if (input.defaultBranch !== undefined && input.defaultBranch !== repository.default_branch) {
    // Config lives in the app (ADR 0370): changing the branch keeps it.
    next.default_branch = input.defaultBranch;
  }
  const before = {
    githubInstallationId: repository.github_installation_id,
    defaultBranch: repository.default_branch,
  };
  const after = {
    githubInstallationId: next.github_installation_id,
    defaultBranch: next.default_branch,
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    ctx.write(
      ctx.db
        .updateTable("core_repositories")
        .set({
          github_installation_id: next.github_installation_id,
          default_branch: next.default_branch,
        })
        .where("id", "=", repository.id),
    );
    ctx.change({ entity: "repository", id: repository.id, before, after });
  }
  ctx.subject({ projectId: repository.project_id, orgId: repository.org_id });
  return next;
}

export const repositoryUpdate = defineOperation({
  name: "repository.update",
  description:
    "Admin fix for a repository's connection to GitHub (ADR 0490; not part of onboarding, which never asks for ids): set its GitHub App installation id (or `detectInstallation: true` to look it up as the App), and/or its default branch. Needs an org owner or admin. Refuses with the reason when detection finds no installation.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: fixRefinements(z.object({ repositoryId, ...repositoryFix })),
  output: repositoryView.extend({ installationWarning }),
  // Scoped to the org: this is how a repository gets connected, so it must work before (and
  // regardless of) the project's config. The org admin check still holds.
  scope: (input, db) => orgOfRepositoryTarget(db, input),
  async handler(input, ctx) {
    const next = await applyRepositoryFix(ctx, await fixTarget(ctx, input), input);
    const [view] = await repositoryViews(ctx.db, [next]);
    return {
      ...(view as RepositoryView),
      installationWarning: next.github_installation_id ? null : noInstallation("none set"),
    };
  },
});

export const projectUpdate = defineOperation({
  name: "project.update",
  description:
    "Admin fix for a project's connection to GitHub (not part of onboarding, which never asks for ids): set its repository's GitHub App installation id (or `detectInstallation: true` to look it up as the App), and/or its default branch. The project's only repository, or the one named by `repositoryId` (repository.update is the same per repository, ADR 0490). Needs an org owner or admin. Changing the default branch keeps the project's config (it lives in the app, ADR 0370). Refuses with the reason when detection finds no installation.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: fixRefinements(
    z.object({ projectId, repositoryId: repositoryId.optional(), ...repositoryFix }),
  ),
  output: projectView.extend({ installationWarning }),
  // Scoped to the org, not the project: this is how a project gets connected, so it must work
  // before (and regardless of) the project's own config. The org admin check still holds.
  scope: (input, db) => orgOfRepositoryTarget(db, { projectId: input.projectId }),
  async handler(input, ctx) {
    const project = await ctx.db
      .selectFrom("core_projects")
      .selectAll()
      .where("id", "=", input.projectId)
      .executeTakeFirst();
    if (!project || project.org_id !== ctx.scope.orgId) {
      throw new OperationError("not_found", "no such project");
    }
    const target = await fixTarget(ctx, input);
    const next = await applyRepositoryFix(ctx, target, input);
    const [view] = await projectViews(ctx.db, [project]);
    const v = view as ProjectView;
    // The view read the repository before this call's write: show it as it will be.
    const repositories = v.repositories.map((r) =>
      r.id === next.id
        ? {
            ...r,
            defaultBranch: next.default_branch,
            githubInstallationId: next.github_installation_id,
            ...(next.github_installation_id
              ? {}
              : { connection: { ...r.connection, status: "missing" as const } }),
          }
        : r,
    );
    const first = repositories[0];
    return {
      ...v,
      repositories,
      repo: first
        ? { owner: first.owner, name: first.name, defaultBranch: first.defaultBranch }
        : null,
      githubInstallationId: first?.githubInstallationId ?? null,
      connection: first?.connection ?? v.connection,
      installationWarning: next.github_installation_id ? null : noInstallation("none set"),
    };
  },
});

export const orgList = defineOperation({
  name: "org.list",
  description:
    "The orgs you belong to, your Personal org first, with your role in each, and your own user id: what the CLI and the desktop app use to find your projects (sf-app reads the same from your session).",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({
    orgs: z.array(
      z.object({ id: z.string(), name: z.string(), kind: z.string(), role: z.string() }),
    ),
    userId: z.string(),
  }),
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_member as m")
      .innerJoin("core_organization as o", "o.id", "m.organization_id")
      .select(["o.id", "o.name", "o.kind", "m.role", "o.created_at"])
      .where("m.user_id", "=", ctx.actor.id)
      .execute();
    rows.sort(
      (a, b) =>
        Number(b.kind === "personal") - Number(a.kind === "personal") ||
        String(a.created_at).localeCompare(String(b.created_at)),
    );
    return {
      orgs: rows.map((r) => ({ id: r.id, name: r.name, kind: String(r.kind), role: r.role })),
      userId: ctx.actor.id,
    };
  },
});

export const projectList = defineOperation({
  name: "project.list",
  description: "List the projects in an org the caller belongs to.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({ projects: z.array(projectView) }),
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_projects")
      .selectAll()
      .where("org_id", "=", input.orgId)
      .orderBy("name")
      .execute();
    return { projects: await projectViews(ctx.db, rows) };
  },
});

export const policySync = defineOperation({
  name: "policy.sync",
  description: `Import a ${POLICY_PATH} document into a project as a new config version (ADR 0370; source \`import\`), as read from the default branch at one commit. A document from any other ref is ignored. A malformed or missing one is still recorded and made current, so the project fails closed until a valid version is saved: prefer config.save, which refuses an invalid document. Human admins only; the push webhook no longer calls it.`,
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    projectId,
    /** The repository the document was read from; needed only when the project has several. */
    repositoryId: repositoryId.optional(),
    ref: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    /** The file's text, or null when the commit has no policy file. */
    content: z.string().max(100_000).nullable(),
  }),
  output: z.object({
    applied: z.boolean(),
    valid: z.boolean(),
    error: z.string().nullable(),
    /** The version it became (`v<N>`), when applied. */
    version: z.string().nullable(),
  }),
  // It brings a policy in, so a missing or malformed one can't block it (ADR 0054).
  bootstrapsPolicy: true,
  allowWhenKilled: true,
  async handler(input, ctx) {
    return recordPolicy(ctx, requireProject(ctx), requireRepository(ctx), input);
  },
});

/**
 * Records a policy document read from one commit as a new config version, only when the ref is the
 * default branch. Used by policy.sync.
 */
export async function recordPolicy(
  ctx: HandlerContext,
  project: ProjectRow,
  repository: Pick<RepositoryRow, "default_branch">,
  input: { ref: string; sha: string; content: string | null },
): Promise<{ applied: boolean; valid: boolean; error: string | null; version: string | null }> {
  const defaultRef = `refs/heads/${repository.default_branch}`;
  const fromDefault = input.ref === defaultRef || input.ref === repository.default_branch;
  if (!fromDefault) {
    return {
      applied: false,
      valid: false,
      error: `ignored: ${input.ref} is not the default branch`,
      version: null,
    };
  }
  const parsed =
    input.content === null
      ? { ok: false as const, error: `no ${POLICY_PATH} at ${input.sha}` }
      : parseProjectPolicy(input.content);
  const error = parsed.ok ? null : parsed.error;
  const written = await writeVersion(ctx, project, {
    raw: input.content ?? "",
    valid: parsed.ok,
    error,
    source: "import",
    note: `Imported from ${input.ref} at ${input.sha.slice(0, 7)}`,
    ref: input.ref,
  });
  return { applied: true, valid: parsed.ok, error, version: written.sha };
}

export const killSwitchSet = defineOperation({
  name: "killSwitch.set",
  description:
    "Turn an org's or a project's kill switch on or off (ADR 0044). On: the covered work items pause at their next step, their runs are stopped and their runner slots freed, and every non-human write to them is refused; people can still decide gates. Off: they resume. Org switch: org owners/admins; project switch: the project's approvers.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  browserOnly: (input) => !input.on, // turning a kill switch on is fine from a terminal
  input: z.object({
    scope: z.enum(["org", "project"]),
    id: z.string().min(1),
    on: z.boolean(),
    reason: z.string().max(500).optional(),
  }),
  output: z.object({
    on: z.boolean(),
    epoch: z.number(),
    workItems: z.number(),
    changed: z.boolean(),
  }),
  scope: async (input) => (input.scope === "org" ? { orgId: input.id } : { projectId: input.id }),
  async handler(input, ctx) {
    const orgId = ctx.scope.orgId;
    if (!orgId) throw new OperationError("not_found", "no such org or project");
    if (input.scope === "org" && !(await isOrgAdmin(ctx.db, orgId, ctx.actor.id))) {
      throw new OperationError("forbidden", "the org kill switch needs an org owner or admin");
    }
    if (input.scope === "project") {
      const approvers = await approverIds(ctx.db, orgId, ctx.scope.policy);
      if (!approvers.includes(ctx.actor.id)) {
        throw new OperationError("forbidden", "the project kill switch needs a project approver");
      }
    }
    const current = await ctx.db
      .selectFrom("core_kill_switches")
      .select(["is_on", "epoch"])
      .where("scope", "=", input.scope)
      .where("scope_id", "=", input.id)
      .executeTakeFirst();
    const wasOn = current?.is_on === 1;
    const epoch = (current?.epoch ?? 0) + (input.on && !wasOn ? 1 : 0);
    if (wasOn === input.on) return { on: input.on, epoch, workItems: 0, changed: false };

    ctx.write(
      ctx.db
        .insertInto("core_kill_switches")
        .values({
          scope: input.scope,
          scope_id: input.id,
          is_on: input.on ? 1 : 0,
          epoch,
          reason: input.reason ?? null,
          changed_at: ctx.now,
          changed_by: ctx.actor.id,
        })
        .onConflict((oc) =>
          oc.columns(["scope", "scope_id"]).doUpdateSet({
            is_on: input.on ? 1 : 0,
            epoch,
            reason: input.reason ?? null,
            changed_at: ctx.now,
            changed_by: ctx.actor.id,
          }),
        ),
    );
    ctx.change({
      entity: "kill_switch",
      id: `${input.scope}:${input.id}`,
      before: { on: wasOn },
      after: { on: input.on, epoch },
    });

    const column = input.scope === "org" ? "org_id" : "project_id";
    const items = await ctx.db
      .selectFrom("core_work_items")
      .select(["id", "project_id", "org_id", "workflow_id", "status"])
      .where(column, "=", input.id)
      .where("status", "in", input.on ? ["running", "waiting"] : ["paused"])
      .execute();

    if (input.on) {
      for (const item of items) {
        ctx.write(
          ctx.db
            .updateTable("core_work_items")
            .set({
              status: "paused",
              status_reason: `kill switch (${input.scope})`,
              updated_at: ctx.now,
            })
            .where("id", "=", item.id),
        );
        ctx.emit({ kind: "workflow.pause", payload: { instanceId: item.workflow_id } });
      }
      // Stop their runs and free their slots: cancel active runs and bump the fencing token so the
      // runner's next write is refused and the host stops (ADR 0035, 0044).
      const runs = await ctx.db
        .selectFrom("core_runs")
        .innerJoin("core_work_items", "core_work_items.id", "core_runs.work_item_id")
        .select([
          "core_runs.id",
          "core_runs.job_id",
          "core_runs.work_item_id",
          "core_work_items.workflow_id",
        ])
        .where(`core_work_items.${column}`, "=", input.id)
        .where("core_runs.status", "in", ["claimed", "preparing", "running", "collecting"])
        .execute();
      for (const run of runs) {
        ctx.write(
          ctx.db
            .updateTable("core_runs")
            .set({ status: "cancelled", outcome: "cancelled", ended_at: ctx.now })
            .where("id", "=", run.id),
        );
        ctx.write(
          ctx.db
            .updateTable("core_jobs")
            .set({ status: "cancelled", finished_at: ctx.now })
            .where("id", "=", run.job_id),
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
            .where("work_item_id", "=", run.work_item_id),
        );
        ctx.emit({
          kind: "workflow.event",
          payload: {
            instanceId: run.workflow_id,
            type: `run-${run.job_id}`,
            payload: { runId: run.id, outcome: "cancelled", reason: "kill switch" },
          },
        });
      }
    } else {
      // Resume only items no other switch still covers.
      for (const item of items) {
        const other = await activeKillSwitch(
          ctx.db,
          input.scope === "org" ? null : item.org_id,
          input.scope === "project" ? null : item.project_id,
        );
        if (other) continue;
        const gate = await ctx.db
          .selectFrom("core_pending_actions")
          .select("id")
          .where("work_item_id", "=", item.id)
          .where("status", "=", "pending")
          .executeTakeFirst();
        ctx.write(
          ctx.db
            .updateTable("core_work_items")
            .set({ status: gate ? "waiting" : "running", status_reason: null, updated_at: ctx.now })
            .where("id", "=", item.id)
            .where("status", "=", "paused"),
        );
        // Releases a step a switch refused mid-flight: it parked on that switch's current epoch.
        // The other scope's switch is off by now (checked above), so its event is safe to send too.
        const other_ =
          input.scope === "org"
            ? { scope: "project" as const, scopeId: item.project_id }
            : { scope: "org" as const, scopeId: item.org_id };
        const otherRow = await ctx.db
          .selectFrom("core_kill_switches")
          .select("epoch")
          .where("scope", "=", other_.scope)
          .where("scope_id", "=", other_.scopeId)
          .executeTakeFirst();
        const events = [resumeEventType({ scope: input.scope, scopeId: input.id, epoch })];
        if (otherRow && otherRow.epoch > 0) {
          events.push(resumeEventType({ ...other_, epoch: otherRow.epoch }));
        }
        ctx.emit({ kind: "workflow.resume", payload: { instanceId: item.workflow_id, events } });
      }
    }
    return { on: input.on, epoch, workItems: items.length, changed: true };
  },
});
