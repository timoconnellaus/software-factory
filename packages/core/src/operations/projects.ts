// Projects, their `.factory/` policy (mirrored from the default branch) and kill switches.
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { idPattern, newId, slugify } from "../ids.ts";
import { defineOperation, type HandlerContext, type ProjectRow } from "../operation.ts";
import { POLICY_PATH, parseProjectPolicy } from "../policy/project-policy.ts";
import { activeKillSwitch, approverIds, isOrgAdmin, resumeEventType } from "../scope.ts";
import type { FactoryServices, RepoRef } from "../services.ts";
import { projectId, requireProject } from "./shared.ts";

const connectionView = z.object({
  /** `missing`: no installation reaches the repo; `suspended`/`deleted`: as GitHub reported. */
  status: z.enum(["connected", "missing", "suspended", "deleted"]),
  /** The GitHub account the App is installed on. */
  account: z.string().nullable(),
  /** Where to change which repositories the App can reach (GitHub's settings page). */
  manageUrl: z.string().nullable(),
});

const policyView = z.object({
  /** `none`: never read; `missing`: no `.factory/policy.json` on the default branch. */
  state: z.enum(["valid", "invalid", "missing", "none"]),
  error: z.string().nullable(),
  /** The open PR that adds a template policy, when one was opened from Setup. */
  prUrl: z.string().nullable(),
});

export const projectView = z.object({
  id: z.string(),
  orgId: z.string(),
  factoryId: z.string(),
  name: z.string(),
  slug: z.string(),
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }),
  policySha: z.string().nullable(),
  /** For admin tools and MCP. The app never shows it (onboarding never asks for ids, ADR 0055). */
  githubInstallationId: z.string().nullable(),
  connection: connectionView,
  policy: policyView,
});
export type ProjectView = z.input<typeof projectView>;

const installationId = z.string().regex(/^\d+$/);

/** Set when a project is saved without a GitHub App installation: why, and what to do. */
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

/** Project rows with their connection and policy state, as every project operation returns them. */
export async function projectViews(db: Db, rows: ProjectRow[]): Promise<ProjectView[]> {
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
  const policies = await db
    .selectFrom("core_project_policies")
    .select(["project_id", "sha", "raw", "valid", "error"])
    .where(
      "project_id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  return rows.map((p) => {
    const record =
      records.find((r) => r.id === p.installation_record_id) ??
      records.find((r) => r.installation_id === p.github_installation_id);
    const policy = policies.find((x) => x.project_id === p.id && x.sha === p.policy_sha);
    const connection: z.input<typeof connectionView> = !p.github_installation_id
      ? { status: "missing", account: record?.account_login ?? null, manageUrl: null }
      : {
          status:
            record?.status === "suspended"
              ? "suspended"
              : record?.status === "deleted"
                ? "deleted"
                : "connected",
          account: record?.account_login ?? p.repo_owner,
          manageUrl: record ? manageInstallationUrl(record) : null,
        };
    return {
      id: p.id,
      orgId: p.org_id,
      factoryId: p.factory_id,
      name: p.name,
      slug: p.slug,
      repo: { owner: p.repo_owner, name: p.repo_name, defaultBranch: p.default_branch },
      policySha: p.policy_sha,
      githubInstallationId: p.github_installation_id,
      connection,
      policy: {
        state: !policy
          ? "none"
          : policy.valid
            ? "valid"
            : policy.raw === ""
              ? "missing"
              : "invalid",
        error: policy && !policy.valid ? policy.error : null,
        prUrl: p.policy_pr_url ?? null,
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
 * Reads `.factory/policy.json` at the default branch's head through the App and records it (ADR
 * 0036, 0054). Used when a project is created, when an installation is connected, and by
 * policy.resync. Returns null when the branch doesn't exist yet (an empty repo).
 */
export async function syncPolicyFromGitHub(
  ctx: HandlerContext,
  project: ProjectRow,
  repo: RepoRef,
): Promise<{ applied: boolean; valid: boolean; error: string | null; sha: string } | null> {
  const head = await ctx.services.github.getBranchSha(repo, project.default_branch);
  if (!head) return null;
  const content = await ctx.services.github.readFile(repo, POLICY_PATH, head);
  const recorded = recordPolicy(ctx, project, {
    ref: `refs/heads/${project.default_branch}`,
    sha: head,
    content,
  });
  return { ...recorded, sha: head };
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

export const projectCreate = defineOperation({
  name: "project.create",
  description:
    "Add a project: one GitHub repository the org's connected GitHub App installation can reach (pick it from github.repos; ADR 0055). Needs an org owner or admin. The default branch comes from GitHub. Refuses, saving nothing, when the installation isn't the org's, isn't active, or can't reach the repo. Reads `.factory/policy.json` from the default branch right away (policy.sync); without a valid one agents and runners can do nothing on the project (fail closed) and Setup offers a PR that adds one.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    orgId: z.string().min(1),
    /** The org's installation record (`ghi_…`) from github.repos. */
    installationRecordId: z.string().regex(idPattern("githubInstallation")),
    /** GitHub's repository id, from github.repos. */
    repoId: z.number().int().positive(),
    /** Defaults to the repo's name. */
    name: z.string().min(1).max(100).optional(),
  }),
  output: projectView,
  async handler(input, ctx) {
    const org = await ctx.db
      .selectFrom("core_organization")
      .select("id")
      .where("id", "=", input.orgId)
      .executeTakeFirst();
    if (!org) throw new OperationError("not_found", "no such org");
    const record = await ctx.db
      .selectFrom("core_github_installations")
      .selectAll()
      .where("id", "=", input.installationRecordId)
      .where("org_id", "=", input.orgId)
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
    const repo = await ctx.services.github.getInstallationRepo(record.installation_id, input.repoId);
    if (!repo) {
      throw new OperationError(
        "unavailable",
        `the GitHub App's installation on ${record.account_login} can't reach that repository. Add it under "Manage repositories on GitHub", then pick it again.`,
      );
    }
    const taken = await ctx.db
      .selectFrom("core_projects")
      .select(["id", "org_id"])
      .where(sql<string>`lower(repo_owner)`, "=", repo.owner.toLowerCase())
      .where(sql<string>`lower(repo_name)`, "=", repo.name.toLowerCase())
      .executeTakeFirst();
    if (taken) {
      throw new OperationError(
        "conflict",
        `${repo.owner}/${repo.name} is already a project${taken.org_id === input.orgId ? "" : " in another org"}`,
      );
    }
    const factoryId = await ensureFactory(ctx, input.orgId);
    const name = input.name ?? repo.name;
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
    const row: ProjectRow = {
      id: newId("project"),
      org_id: input.orgId,
      factory_id: factoryId,
      name,
      slug,
      repo_owner: repo.owner,
      repo_name: repo.name,
      default_branch: repo.defaultBranch,
      github_installation_id: record.installation_id,
      installation_record_id: record.id,
      github_repo_id: repo.id,
      policy_sha: null,
      policy_pr_url: null,
      next_number: 1,
      created_at: ctx.now,
      created_by: ctx.actor.id,
    };
    ctx.write(ctx.db.insertInto("core_projects").values(row));
    ctx.change({
      entity: "project",
      id: row.id,
      after: { name, repo: `${repo.owner}/${repo.name}`, repoId: repo.id, installation: record.id },
    });
    ctx.subject({ projectId: row.id, orgId: input.orgId });
    // The policy, read now through the App, in the same batch: no "Sync" step for people.
    const synced = await syncPolicyFromGitHub(ctx, row, {
      installationId: record.installation_id,
      owner: repo.owner,
      repo: repo.name,
    });
    const policyState = !synced
      ? { state: "none" as const, error: null }
      : synced.valid
        ? { state: "valid" as const, error: null }
        : { state: synced.error?.startsWith("no ") ? ("missing" as const) : ("invalid" as const), error: synced.error };
    return {
      id: row.id,
      orgId: row.org_id,
      factoryId,
      name,
      slug: row.slug,
      repo: { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
      policySha: synced?.sha ?? null,
      githubInstallationId: record.installation_id,
      connection: {
        status: "connected" as const,
        account: record.account_login,
        manageUrl: manageInstallationUrl(record),
      },
      policy: { ...policyState, prUrl: null },
    };
  },
});

export const projectUpdate = defineOperation({
  name: "project.update",
  description:
    "Admin fix for a project's connection to GitHub (not part of onboarding, which never asks for ids): set its GitHub App installation id (or `detectInstallation: true` to look it up as the App), and/or its default branch. Needs an org owner or admin. Changing the default branch clears the synced policy: it is re-read from the new branch (policy.sync) and the project fails closed until then. Refuses with the reason when detection finds no installation.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z
    .object({
      projectId,
      githubInstallationId: installationId.nullable().optional(),
      detectInstallation: z.boolean().optional(),
      defaultBranch: z.string().min(1).max(100).optional(),
    })
    .refine((i) => !(i.detectInstallation && i.githubInstallationId !== undefined), {
      message: "give githubInstallationId or detectInstallation, not both",
    })
    .refine(
      (i) =>
        i.detectInstallation ||
        i.githubInstallationId !== undefined ||
        i.defaultBranch !== undefined,
      { message: "nothing to change" },
    ),
  output: projectView.extend({ installationWarning }),
  // Scoped to the org, not the project: this is how a project gets connected, so it must work
  // before (and regardless of) the project's own `.factory/` policy. The org admin check still holds.
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
    const next = { ...project };
    if (input.detectInstallation) {
      const found = await detect(ctx.services, project.repo_owner, project.repo_name);
      if (!found.installationId)
        throw new OperationError("not_found", noInstallation(found.reason ?? "not found"));
      next.github_installation_id = found.installationId;
    } else if (input.githubInstallationId !== undefined) {
      next.github_installation_id = input.githubInstallationId;
    }
    if (input.defaultBranch !== undefined && input.defaultBranch !== project.default_branch) {
      next.default_branch = input.defaultBranch;
      next.policy_sha = null;
    }
    const before = {
      githubInstallationId: project.github_installation_id,
      defaultBranch: project.default_branch,
      policySha: project.policy_sha,
    };
    const after = {
      githubInstallationId: next.github_installation_id,
      defaultBranch: next.default_branch,
      policySha: next.policy_sha,
    };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      ctx.write(
        ctx.db
          .updateTable("core_projects")
          .set({
            github_installation_id: next.github_installation_id,
            default_branch: next.default_branch,
            policy_sha: next.policy_sha,
          })
          .where("id", "=", project.id),
      );
      ctx.change({ entity: "project", id: project.id, before, after });
    }
    ctx.subject({ projectId: project.id, orgId: project.org_id });
    const [view] = await projectViews(ctx.db, [next]);
    return {
      ...(view as ProjectView),
      installationWarning: next.github_installation_id ? null : noInstallation("none set"),
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
  description: `Record a project's ${POLICY_PATH} as read from its default branch at one commit (ADR 0036). Called by the GitHub connector on each push to the default branch. A policy from any other ref is ignored (recorded, not applied). A malformed one is recorded and applied: it fails closed.`,
  risk: "write",
  actors: ["intake", "human"],
  permission: "admin",
  input: z.object({
    projectId,
    ref: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    /** The file's text, or null when the commit has no policy file. */
    content: z.string().max(100_000).nullable(),
  }),
  output: z.object({
    applied: z.boolean(),
    valid: z.boolean(),
    error: z.string().nullable(),
  }),
  // The connector brings the policy in, so a missing or malformed one can't block it (ADR 0054).
  bootstrapsPolicy: true,
  allowWhenKilled: true,
  async handler(input, ctx) {
    return recordPolicy(ctx, requireProject(ctx), input);
  },
});

/**
 * Records `.factory/policy.json` as read from one commit, and applies it only when the ref is the
 * default branch (ADR 0036). Shared by policy.sync and the connector's push.observe.
 */
export function recordPolicy(
  ctx: HandlerContext,
  project: ProjectRow,
  input: { ref: string; sha: string; content: string | null },
): { applied: boolean; valid: boolean; error: string | null } {
  const defaultRef = `refs/heads/${project.default_branch}`;
  const fromDefault = input.ref === defaultRef || input.ref === project.default_branch;
  if (!fromDefault) {
    // Policy is read from the default branch only: an agent can't loosen its own policy from a
    // branch (ADR 0036). The refusal is audited by this call's audit row.
    return {
      applied: false,
      valid: false,
      error: `ignored: ${input.ref} is not the default branch`,
    };
  }
  const parsed =
    input.content === null
      ? { ok: false as const, error: `no ${POLICY_PATH} at ${input.sha}` }
      : parseProjectPolicy(input.content);
  const error = parsed.ok ? null : parsed.error;
  ctx.write(
    ctx.db
      .insertInto("core_project_policies")
      .values({
        project_id: project.id,
        sha: input.sha,
        ref: input.ref,
        raw: input.content ?? "",
        valid: parsed.ok ? 1 : 0,
        error,
        received_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(["project_id", "sha"]).doNothing()),
  );
  ctx.write(
    ctx.db.updateTable("core_projects").set({ policy_sha: input.sha }).where("id", "=", project.id),
  );
  ctx.change({
    entity: "project",
    id: project.id,
    before: { policySha: project.policy_sha },
    after: { policySha: input.sha, valid: parsed.ok },
  });
  return { applied: true, valid: parsed.ok, error };
}

export const killSwitchSet = defineOperation({
  name: "killSwitch.set",
  description:
    "Turn an org's or a project's kill switch on or off (ADR 0044). On: the covered work items pause at their next step, their runs are stopped and their runner slots freed, and every non-human write to them is refused; people can still decide gates. Off: they resume. Org switch: org owners/admins; project switch: the project's approvers.",
  risk: "write",
  actors: ["human"],
  permission: "member",
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
