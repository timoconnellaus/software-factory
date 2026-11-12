// Onboarding (ADR 0055): connect the org's GitHub App installation by GitHub's own install flow,
// pick a repo it can reach, let the policy sync itself, and offer a PR that adds one. Nobody types
// or sees an installation id. "Onboarding must never ask users for ids the system can fetch"
// (incident 2026-11-11-bootstrap).
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext, type ProjectRow } from "../operation.ts";
import { POLICY_PATH } from "../policy/project-policy.ts";
import { isOrgAdmin } from "../scope.ts";
import type { InstallationInfo, InstallationRepo } from "../services.ts";
import {
  manageInstallationUrl,
  type ProjectView,
  projectView,
  projectViews,
  syncPolicyFromGitHub,
} from "./projects.ts";
import {
  missingProtectionEvents,
  type ProtectionView,
  protectionView,
  protectionViewFor,
} from "./protection.ts";
import {
  projectId,
  repoRef,
  repoSlug,
  repositoryId,
  requireProject,
  requireRepository,
} from "./shared.ts";
import { RUNNER_OFFLINE_MS } from "./work-items.ts";

/** How long a "Connect GitHub" round trip may take. */
export const CONNECT_STATE_TTL_MS = 15 * 60_000;
/** The branch the App opens the template-policy PR from (inside `factory/*`, ADR 0052). */
export const POLICY_PR_BRANCH = "factory/setup-policy";

type InstallationRecord = {
  id: string;
  org_id: string;
  installation_id: string;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  status: "active" | "suspended" | "deleted";
};

const installationView = z.object({
  id: z.string(),
  account: z.string(),
  accountType: z.enum(["User", "Organization"]),
  repositorySelection: z.enum(["all", "selected"]),
  status: z.enum(["active", "suspended", "deleted"]),
  /** GitHub's page for choosing which repositories the App can reach. */
  manageUrl: z.string(),
});

function toInstallationView(r: InstallationRecord): z.input<typeof installationView> {
  return {
    id: r.id,
    account: r.account_login,
    accountType: r.account_type,
    repositorySelection: r.repository_selection,
    status: r.status,
    manageUrl: manageInstallationUrl(r),
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const githubConnectStart = defineOperation({
  name: "github.connectStart",
  description:
    "Start connecting a GitHub account to the org (ADR 0055): returns GitHub's install URL for the factory's App, carrying a fresh single-use `state` bound to this org and person (it expires in 15 minutes). GitHub sends the person back to the app's /integrations/github/setup with the installation, which github.connectInstallation verifies. Needs an org owner or admin.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({ url: z.string(), state: z.string(), expiresAt: z.string() }),
  redact: { output: (o) => ({ ...o, url: "[redacted]", state: "[redacted]" }) },
  async handler(input, ctx) {
    const slug = ctx.services.github.app.slug;
    if (!slug) throw new OperationError("unavailable", "the factory's GitHub App isn't configured");
    const state = randomToken();
    const expiresAt = new Date(Date.parse(ctx.now) + CONNECT_STATE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_github_connect_states").values({
        state_hash: await sha256Hex(state),
        org_id: input.orgId,
        user_id: ctx.actor.id,
        created_at: ctx.now,
        expires_at: expiresAt,
        used_at: null,
      }),
    );
    return {
      url: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
      state,
      expiresAt,
    };
  },
});

export const githubConnectInstallation = defineOperation({
  name: "github.connectInstallation",
  description:
    "Finish connecting a GitHub App installation, from GitHub's redirect to /integrations/github/setup (ADR 0055). With `state` (a new install): the state must be the one this person started for the org, unused and unexpired (CSRF). Without it (`setup_action=update` from GitHub's settings): the installation must already be connected to an org this person administers. Either way the installation is checked as the App (`GET /app/installations/{id}`; an id GitHub doesn't know is refused) and the person must have access to it: it is on their own account, or their GitHub user token lists it. Then it is recorded (or refreshed) for the org, and the org's projects on that account are linked to it and their policies read. `setup_action=request` (an org member asked an owner to approve) records nothing.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({
    installationId: z.string().regex(/^\d{1,20}$/),
    setupAction: z.enum(["install", "update", "request"]).default("install"),
    state: z.string().min(16).max(200).optional(),
    /** The person's GitHub user token, only to prove access to an org-account installation. Never stored. */
    userAccessToken: z.string().min(1).max(500).optional(),
  }),
  output: z.object({
    outcome: z.enum(["connected", "updated", "requested"]),
    orgId: z.string().nullable(),
    installation: installationView.nullable(),
    linkedProjects: z.array(z.string()),
  }),
  redact: {
    input: (i) => ({
      ...i,
      state: i.state ? "[redacted]" : undefined,
      userAccessToken: i.userAccessToken ? "[redacted]" : undefined,
    }),
  },
  async handler(input, ctx) {
    const existing = (await ctx.db
      .selectFrom("core_github_installations")
      .selectAll()
      .where("installation_id", "=", input.installationId)
      .executeTakeFirst()) as InstallationRecord | undefined;

    let orgId: string;
    if (input.state) {
      const hash = await sha256Hex(input.state);
      const row = await ctx.db
        .selectFrom("core_github_connect_states")
        .selectAll()
        .where("state_hash", "=", hash)
        .executeTakeFirst();
      if (!row) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection wasn't started here (unknown state)",
        );
      }
      if (row.user_id !== ctx.actor.id) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection was started by someone else: start it again from Setup",
        );
      }
      if (row.used_at) {
        throw new OperationError("forbidden", "this GitHub connection link was already used");
      }
      if (Date.parse(row.expires_at) <= Date.parse(ctx.now)) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection link expired: start it again from Setup",
        );
      }
      orgId = row.org_id;
      // Single use: the state is spent in this call's batch, or the batch fails.
      ctx.write(
        ctx.db
          .updateTable("core_github_connect_states")
          .set({ used_at: ctx.now })
          .where("state_hash", "=", hash)
          .where("used_at", "is", null),
      );
      ctx.guardChanged("state single use");
    } else if (existing) {
      orgId = existing.org_id;
    } else {
      throw new OperationError(
        "forbidden",
        "GitHub sent an installation the factory didn't ask for: connect it from Setup → Connect GitHub",
      );
    }
    if (!(await isOrgAdmin(ctx.db, orgId, ctx.actor.id))) {
      throw new OperationError("forbidden", "connecting GitHub needs an org owner or admin");
    }
    if (existing && existing.org_id !== orgId) {
      throw new OperationError(
        "conflict",
        `the GitHub App's installation on ${existing.account_login} is already connected to another org`,
      );
    }
    if (input.setupAction === "request") {
      return { outcome: "requested" as const, orgId, installation: null, linkedProjects: [] };
    }

    // As the App: does this installation exist, and is it ours?
    const info = await ctx.services.github.getInstallation(input.installationId);
    if (!info) {
      throw new OperationError(
        "not_found",
        "GitHub doesn't know that installation of the factory's App: connect again from Setup",
      );
    }
    await requireAccess(ctx, info, input.userAccessToken);

    const status = info.suspended ? ("suspended" as const) : ("active" as const);
    const record: InstallationRecord = {
      id: existing?.id ?? newId("githubInstallation"),
      org_id: orgId,
      installation_id: info.installationId,
      account_login: info.account.login,
      account_type: info.account.type,
      repository_selection: info.repositorySelection,
      status,
    };
    if (existing) {
      ctx.write(
        ctx.db
          .updateTable("core_github_installations")
          .set({
            account_login: record.account_login,
            account_type: record.account_type,
            repository_selection: record.repository_selection,
            status,
            updated_at: ctx.now,
          })
          .where("id", "=", existing.id),
      );
    } else {
      ctx.write(
        ctx.db.insertInto("core_github_installations").values({
          ...record,
          connected_by: ctx.actor.id,
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
    }
    ctx.change({
      entity: "github_installation",
      id: record.id,
      before: existing ? { status: existing.status, account: existing.account_login } : null,
      after: { status, account: record.account_login, selection: record.repository_selection },
    });
    ctx.subject({ orgId });
    const linkedProjects =
      status === "active" ? await linkProjects(ctx, record, info.account.login) : [];
    return {
      outcome: existing ? ("updated" as const) : ("connected" as const),
      orgId,
      installation: toInstallationView(record),
      linkedProjects,
    };
  },
});

/** The person may connect this installation: it is their own account, or GitHub lists it for them. */
async function requireAccess(ctx: HandlerContext, info: InstallationInfo, userToken?: string) {
  const user = await ctx.db
    .selectFrom("core_user")
    .select("github_login")
    .where("id", "=", ctx.actor.id)
    .executeTakeFirst();
  const login = user?.github_login?.toLowerCase() ?? null;
  if (info.account.type === "User" && login && info.account.login.toLowerCase() === login) return;
  if (userToken) {
    let ids: string[] = [];
    try {
      ids = await ctx.services.github.userInstallationIds(userToken);
    } catch (err) {
      throw new OperationError(
        "forbidden",
        `couldn't confirm your access to the installation on ${info.account.login}: ${err instanceof Error ? err.message : String(err)}. Sign out and in again, then retry.`,
      );
    }
    if (ids.includes(info.installationId)) return;
  }
  throw new OperationError(
    "forbidden",
    `your GitHub account doesn't have access to the App's installation on ${info.account.login}`,
  );
}

/**
 * Points the org's projects on this account at the installation when it reaches their repo (by
 * name, recording GitHub's repo id), and reads the policy of any that has none yet. This is how a
 * project created before installations were records (the first `software-factory`) gets connected.
 */
async function linkProjects(
  ctx: HandlerContext,
  record: InstallationRecord,
  account: string,
): Promise<string[]> {
  const repositories = await ctx.db
    .selectFrom("core_repositories")
    .selectAll()
    .where("org_id", "=", record.org_id)
    .where(sql<string>`lower(owner)`, "=", account.toLowerCase())
    .execute();
  const candidates = repositories.filter(
    (r) =>
      r.installation_record_id !== record.id || r.github_installation_id !== record.installation_id,
  );
  if (candidates.length === 0) return [];
  let repos: InstallationRepo[];
  try {
    repos = await ctx.services.github.listInstallationRepos(record.installation_id);
  } catch {
    return [];
  }
  const linked: string[] = [];
  for (const p of candidates) {
    const repo = repos.find(
      (r) =>
        (p.github_repo_id !== null && r.id === p.github_repo_id) ||
        (r.owner.toLowerCase() === p.owner.toLowerCase() &&
          r.name.toLowerCase() === p.name.toLowerCase()),
    );
    if (!repo) continue;
    ctx.write(
      ctx.db
        .updateTable("core_repositories")
        .set({
          github_installation_id: record.installation_id,
          installation_record_id: record.id,
          github_repo_id: repo.id,
        })
        .where("id", "=", p.id),
    );
    ctx.change({
      entity: "repository",
      id: p.id,
      before: { installation: p.github_installation_id, repoId: p.github_repo_id },
      after: { installation: record.installation_id, repoId: repo.id },
    });
    const project = await ctx.db
      .selectFrom("core_projects")
      .selectAll()
      .where("id", "=", p.project_id)
      .executeTakeFirst();
    // Once per project: two of its repositories in one batch would write the same version.
    if (project && !project.policy_sha && !linked.includes(project.id)) {
      await syncPolicyFromGitHub(ctx, project, p, {
        installationId: record.installation_id,
        owner: p.owner,
        repo: p.name,
      }).catch(() => null);
    }
    if (!linked.includes(p.project_id)) linked.push(p.project_id);
  }
  return linked;
}

async function orgRecords(db: Db, orgId: string): Promise<InstallationRecord[]> {
  return (await db
    .selectFrom("core_github_installations")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("status", "!=", "deleted")
    .orderBy("created_at")
    .execute()) as InstallationRecord[];
}

export const githubRepos = defineOperation({
  name: "github.repos",
  description:
    "The repositories the org's connected GitHub App installations can reach, as GitHub reports them now (installation tokens; ADR 0055): the repo picker for project.create. Each says which project already uses it. `problems` names an installation GitHub couldn't list.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({
    repos: z.array(
      z.object({
        installationRecordId: z.string(),
        account: z.string(),
        repoId: z.number(),
        owner: z.string(),
        name: z.string(),
        private: z.boolean(),
        defaultBranch: z.string(),
        projectId: z.string().nullable(),
      }),
    ),
    problems: z.array(z.object({ account: z.string(), error: z.string() })),
  }),
  async handler(input, ctx) {
    const records = (await orgRecords(ctx.db, input.orgId)).filter((r) => r.status === "active");
    const projects = (
      await ctx.db
        .selectFrom("core_repositories")
        .select(["project_id", "owner", "name", "github_repo_id"])
        .where("org_id", "=", input.orgId)
        .execute()
    ).map((r) => ({ ...r, id: r.project_id }));
    const repos = [];
    const problems = [];
    for (const record of records) {
      try {
        for (const r of await ctx.services.github.listInstallationRepos(record.installation_id)) {
          const project = projects.find(
            (p) =>
              p.github_repo_id === r.id ||
              (p.owner.toLowerCase() === r.owner.toLowerCase() &&
                p.name.toLowerCase() === r.name.toLowerCase()),
          );
          repos.push({
            installationRecordId: record.id,
            account: record.account_login,
            repoId: r.id,
            owner: r.owner,
            name: r.name,
            private: r.private,
            defaultBranch: r.defaultBranch,
            projectId: project?.id ?? null,
          });
        }
      } catch (err) {
        problems.push({
          account: record.account_login,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    repos.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
    return { repos, problems };
  },
});

export const policyResync = defineOperation({
  name: "policy.resync",
  description: `Import the project's ${POLICY_PATH} from its default branch's head, through the GitHub App, as a new config version (ADR 0370; source \`import\`). Refuses when the repo has no such file or it isn't valid, and nothing changes. Config otherwise lives in the app: pushes never change it. Needs an org owner or admin.`,
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    projectId,
    /** The repository to import from (ADR 0490); needed only when the project has several. */
    repositoryId: repositoryId.optional(),
  }),
  output: z.object({
    applied: z.boolean(),
    valid: z.boolean(),
    error: z.string().nullable(),
    sha: z.string().nullable(),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    const synced = await syncPolicyFromGitHub(
      ctx,
      project,
      repository,
      await repoRef(ctx, repository),
      { importOnly: true },
    );
    if (!synced) {
      throw new OperationError(
        "unavailable",
        `${repoSlug(repository)} has no ${repository.default_branch} branch yet`,
      );
    }
    return { applied: synced.applied, valid: synced.valid, error: synced.error, sha: synced.sha };
  },
});

const STEP_KEYS = ["github", "project", "policy", "runner", "protect"] as const;

/** A project as Setup names it: its first repository, else its name. */
const repoLabel = (p: Pick<ProjectView, "name" | "repo">) =>
  p.repo ? `${p.repo.owner}/${p.repo.name}` : p.name;

export const setupStatus = defineOperation({
  name: "setup.status",
  description:
    "The Setup checklist for an org, live: GitHub connected, a project, its policy valid, one of your runners online, and the default branch protected (ADR 0280: the rules in force match the generated ruleset, asked of GitHub with the App's read-only access; Setup offers the file to import, the deep link to GitHub's rulesets page, and a message for the repo admin when the viewer isn't one). Each step says what's wrong; `complete` is true when all are green. `missingEvents` lists App webhook events drift detection needs that the App isn't subscribed to.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({
    complete: z.boolean(),
    steps: z.array(z.object({ key: z.enum(STEP_KEYS), done: z.boolean(), detail: z.string() })),
    installations: z.array(installationView),
    projects: z.array(
      projectView.extend({
        /** Null until the project is connected. */
        protection: protectionView.nullable(),
      }),
    ),
    /** App events (repository_ruleset, branch_protection_rule) to tick on the App's settings. */
    missingEvents: z.array(z.string()),
    runners: z.object({ total: z.number(), online: z.number() }),
  }),
  async handler(input, ctx) {
    const records = await orgRecords(ctx.db, input.orgId);
    const rows = await ctx.db
      .selectFrom("core_projects")
      .selectAll()
      .where("org_id", "=", input.orgId)
      .orderBy("name")
      .execute();
    const views = await projectViews(ctx.db, rows);
    const firstRepos = await ctx.db
      .selectFrom("core_repositories")
      .selectAll()
      .where("org_id", "=", input.orgId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const projects: (ProjectView & { protection: ProtectionView | null })[] = [];
    for (const [i, view] of views.entries()) {
      const row = rows[i] as ProjectRow;
      // Protection is still checked on the project's first repository (ADR 0490).
      const repository = firstRepos.find((r) => r.project_id === row.id);
      const protection =
        view.connection.status === "connected" && repository
          ? await protectionViewFor(ctx, row, repository)
          : null;
      projects.push({ ...view, protection });
    }
    const runners = await ctx.db
      .selectFrom("core_runners")
      .select("last_seen_at")
      .where("owner_user_id", "=", ctx.actor.id)
      .where("revoked_at", "is", null)
      .execute();
    const now = Date.parse(ctx.now);
    const online = runners.filter(
      (r) => r.last_seen_at && now - Date.parse(r.last_seen_at) < RUNNER_OFFLINE_MS,
    ).length;

    const active = records.filter((r) => r.status === "active");
    const connected = projects.filter((p) => p.connection.status === "connected");
    const withPolicy = connected.filter((p) => p.policy.state === "valid");
    const protectedOnes = withPolicy.filter((p) => p.protection?.state === "ok");
    const first = connected[0] ?? projects[0];
    const steps = [
      {
        key: "github" as const,
        done: active.length > 0,
        detail: active.length
          ? `Connected: ${active.map((r) => r.account_login).join(", ")}`
          : records.length
            ? `The App's installation on ${records[0]?.account_login} is ${records[0]?.status}`
            : "Connect GitHub to let the factory reach your repositories",
      },
      {
        key: "project" as const,
        done: connected.length > 0,
        detail: connected.length
          ? connected.map(repoLabel).join(", ")
          : projects.length
            ? `${first ? repoLabel(first) : "The project"} isn't reachable by a connected installation`
            : "Add a project: pick one of your repositories",
      },
      {
        key: "policy" as const,
        done: connected.length > 0 && withPolicy.length === connected.length,
        detail: !connected.length
          ? "Created with the project, in Settings"
          : withPolicy.length === connected.length
            ? connected.map((p) => `${p.name}: config v${p.configVersion ?? "?"}`).join(", ")
            : connected
                .filter((p) => p.policy.state !== "valid")
                .map((p) =>
                  p.policy.state === "missing" || p.policy.state === "none"
                    ? `${p.name} has no factory config: open its Settings`
                    : `${p.name}: ${p.policy.error} (fix it in Settings)`,
                )
                .join("; "),
      },
      {
        key: "runner" as const,
        done: online > 0,
        detail: online
          ? `${online} of your runners online`
          : runners.length
            ? "Your runner is offline: start it on its machine"
            : "Connect a runner: run `sf-runner login` on the machine that will build",
      },
      {
        key: "protect" as const,
        done: withPolicy.length > 0 && protectedOnes.length === withPolicy.length,
        detail: !withPolicy.length
          ? "Once the project has a policy"
          : protectedOnes.length === withPolicy.length
            ? `${withPolicy.map((p) => p.repo?.defaultBranch ?? p.name).join(", ")} protected: a PR, ci and factory/verify required, no bypass`
            : withPolicy
                .filter((p) => p.protection?.state !== "ok")
                .map((p) => `${p.name}: ${(p.protection?.problems ?? ["not checked"]).join("; ")}`)
                .join(" · "),
      },
    ];
    return {
      complete: steps.every((s) => s.done),
      steps,
      installations: records.map(toInstallationView),
      projects,
      runners: { total: runners.length, online },
      missingEvents: connected.length ? await missingProtectionEvents(ctx) : [],
    };
  },
});
