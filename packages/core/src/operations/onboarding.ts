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
import { checkRepoGuards } from "../verify/onboarding.ts";
import {
  manageInstallationUrl,
  type ProjectView,
  projectView,
  projectViews,
  syncPolicyFromGitHub,
} from "./projects.ts";
import { projectId, repoRef, requireProject } from "./shared.ts";
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
  const projects = await ctx.db
    .selectFrom("core_projects")
    .selectAll()
    .where("org_id", "=", record.org_id)
    .where(sql<string>`lower(repo_owner)`, "=", account.toLowerCase())
    .execute();
  const candidates = projects.filter(
    (p) =>
      p.installation_record_id !== record.id || p.github_installation_id !== record.installation_id,
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
        (r.owner.toLowerCase() === p.repo_owner.toLowerCase() &&
          r.name.toLowerCase() === p.repo_name.toLowerCase()),
    );
    if (!repo) continue;
    const next: ProjectRow = {
      ...p,
      github_installation_id: record.installation_id,
      installation_record_id: record.id,
      github_repo_id: repo.id,
    };
    ctx.write(
      ctx.db
        .updateTable("core_projects")
        .set({
          github_installation_id: record.installation_id,
          installation_record_id: record.id,
          github_repo_id: repo.id,
        })
        .where("id", "=", p.id),
    );
    ctx.change({
      entity: "project",
      id: p.id,
      before: { installation: p.github_installation_id, repoId: p.github_repo_id },
      after: { installation: record.installation_id, repoId: repo.id },
    });
    if (!p.policy_sha) {
      await syncPolicyFromGitHub(ctx, next, {
        installationId: record.installation_id,
        owner: p.repo_owner,
        repo: p.repo_name,
      }).catch(() => null);
    }
    linked.push(p.id);
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
    const projects = await ctx.db
      .selectFrom("core_projects")
      .select(["id", "repo_owner", "repo_name", "github_repo_id"])
      .where("org_id", "=", input.orgId)
      .execute();
    const repos = [];
    const problems = [];
    for (const record of records) {
      try {
        for (const r of await ctx.services.github.listInstallationRepos(record.installation_id)) {
          const project = projects.find(
            (p) =>
              p.github_repo_id === r.id ||
              (p.repo_owner.toLowerCase() === r.owner.toLowerCase() &&
                p.repo_name.toLowerCase() === r.name.toLowerCase()),
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
  description: `Read the project's ${POLICY_PATH} again from its default branch's head, through the GitHub App, and record it (policy.sync). The push webhook does this on every push to the default branch; this is the manual "Re-sync". Needs an org owner or admin.`,
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({ projectId }),
  output: z.object({
    applied: z.boolean(),
    valid: z.boolean(),
    error: z.string().nullable(),
    sha: z.string().nullable(),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const synced = await syncPolicyFromGitHub(ctx, project, await repoRef(ctx, project));
    if (!synced) {
      throw new OperationError(
        "unavailable",
        `${project.repo_owner}/${project.repo_name} has no ${project.default_branch} branch yet`,
      );
    }
    return synced;
  },
});

/** The policy a new project starts from: Balanced, the person opening the PR as its approver. */
export function templatePolicy(approverLogin: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      autonomyPolicy: "balanced",
      spec: { requiredFrom: "medium" },
      timeouts: { gateHours: 72, questionHours: 48 },
      wipLimit: 5,
      retryLimit: 2,
      approvers: [approverLogin],
      backupOwner: approverLogin,
    },
    null,
    2,
  )}\n`;
}

export const policyProposeTemplate = defineOperation({
  name: "policy.proposeTemplate",
  description: `Open a pull request, as the GitHub App, that adds a template ${POLICY_PATH} to a project that has none: autonomy policy Balanced, the person asking as approver and backup owner. Human only (it proposes the project's own policy). Refuses when the default branch already has the file. Merging it is up to a person on GitHub; the push webhook then syncs it.`,
  risk: "outbound",
  actors: ["human"],
  permission: "admin",
  input: z.object({ projectId }),
  output: z.object({ url: z.string(), number: z.number(), branch: z.string() }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const user = await ctx.db
      .selectFrom("core_user")
      .select("github_login")
      .where("id", "=", ctx.actor.id)
      .executeTakeFirst();
    if (!user?.github_login) {
      throw new OperationError("conflict", "your account has no GitHub login to name as approver");
    }
    const repo = await repoRef(ctx, project);
    const gh = ctx.services.github;
    const head = await gh.getBranchSha(repo, project.default_branch);
    if (!head) {
      throw new OperationError(
        "unavailable",
        `no ${project.default_branch} branch to propose against`,
      );
    }
    if ((await gh.readFile(repo, POLICY_PATH, head)) !== null) {
      throw new OperationError(
        "conflict",
        `${project.default_branch} already has ${POLICY_PATH}: fix that file instead (Re-sync shows its error)`,
      );
    }
    await gh.createBranch(repo, POLICY_PR_BRANCH, head);
    await gh.commitFile(repo, {
      branch: POLICY_PR_BRANCH,
      path: POLICY_PATH,
      content: templatePolicy(user.github_login),
      message: "Add the factory policy (.factory/policy.json)",
    });
    const pr = await gh.openPullRequest(repo, {
      head: POLICY_PR_BRANCH,
      base: project.default_branch,
      title: "Add the factory policy",
      body: [
        `Adds \`${POLICY_PATH}\`, the project's autonomy policy (ADR 0054), opened from the factory's Setup by @${user.github_login}.`,
        "",
        `- Autonomy policy: **Balanced**`,
        `- Approver and backup owner: \`${user.github_login}\``,
        "",
        "Until a valid policy is on the default branch, agents and runners can do nothing on this project (fail closed). Merging this syncs it automatically.",
      ].join("\n"),
    });
    ctx.write(
      ctx.db
        .updateTable("core_projects")
        .set({ policy_pr_url: pr.url })
        .where("id", "=", project.id),
    );
    ctx.change({ entity: "project", id: project.id, after: { policyPr: pr.url } });
    return { url: pr.url, number: pr.number, branch: POLICY_PR_BRANCH };
  },
});

const STEP_KEYS = ["github", "project", "policy", "runner", "verify"] as const;

export const setupStatus = defineOperation({
  name: "setup.status",
  description:
    "The Setup checklist for an org, live: GitHub connected, a project, its policy valid, one of your runners online, and `factory/verify` required on the default branch (asked of GitHub as the App). Each step says what's wrong; `complete` is true when all are green.",
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
        verify: z.object({ ok: z.boolean(), problems: z.array(z.string()) }).nullable(),
      }),
    ),
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
    const projects: (ProjectView & { verify: { ok: boolean; problems: string[] } | null })[] = [];
    for (const [i, view] of views.entries()) {
      const row = rows[i] as ProjectRow;
      let verify: { ok: boolean; problems: string[] } | null = null;
      if (view.connection.status === "connected") {
        try {
          const gh = ctx.services.github;
          const repo = await repoRef(ctx, row);
          verify = checkRepoGuards(await gh.repoGuards(repo, row.default_branch), gh.app.id);
        } catch (err) {
          verify = {
            ok: false,
            problems: [
              `couldn't read branch protection: ${err instanceof Error ? err.message : String(err)}`,
            ],
          };
        }
      }
      projects.push({ ...view, verify });
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
    const verified = withPolicy.filter((p) => p.verify?.ok);
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
          ? connected.map((p) => `${p.repo.owner}/${p.repo.name}`).join(", ")
          : projects.length
            ? `${first?.repo.owner}/${first?.repo.name} isn't reachable by a connected installation`
            : "Add a project: pick one of your repositories",
      },
      {
        key: "policy" as const,
        done: connected.length > 0 && withPolicy.length === connected.length,
        detail: !connected.length
          ? "Comes from the project's .factory/policy.json"
          : withPolicy.length === connected.length
            ? "Valid .factory/policy.json on the default branch"
            : connected
                .filter((p) => p.policy.state !== "valid")
                .map((p) =>
                  p.policy.state === "missing" || p.policy.state === "none"
                    ? `${p.name} has no factory policy`
                    : `${p.name}: ${p.policy.error}`,
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
        key: "verify" as const,
        done: withPolicy.length > 0 && verified.length === withPolicy.length,
        detail: !withPolicy.length
          ? "Once the project has a policy"
          : verified.length === withPolicy.length
            ? "factory/verify is required on the default branch"
            : withPolicy
                .filter((p) => !p.verify?.ok)
                .map((p) => `${p.name}: ${(p.verify?.problems ?? ["not checked"]).join("; ")}`)
                .join(" · "),
      },
    ];
    return {
      complete: steps.every((s) => s.done),
      steps,
      installations: records.map(toInstallationView),
      projects,
      runners: { total: runners.length, online },
    };
  },
});
