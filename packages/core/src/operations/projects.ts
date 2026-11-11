// Projects, their `.factory/` policy (mirrored from the default branch) and kill switches.
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId, slugify } from "../ids.ts";
import { defineOperation, type HandlerContext, type ProjectRow } from "../operation.ts";
import { POLICY_PATH, parseProjectPolicy } from "../policy/project-policy.ts";
import { activeKillSwitch, approverIds, isOrgAdmin, resumeEventType } from "../scope.ts";
import { projectId, requireProject } from "./shared.ts";

const projectView = z.object({
  id: z.string(),
  orgId: z.string(),
  factoryId: z.string(),
  name: z.string(),
  slug: z.string(),
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }),
  policySha: z.string().nullable(),
  githubInstallationId: z.string().nullable(),
});

export const projectCreate = defineOperation({
  name: "project.create",
  description:
    "Add a project: one GitHub repo inside the org's factory. Needs an org owner or admin. Its policy is read from `.factory/policy.json` on the default branch (policy.sync); until one is synced, agents and runners can do nothing on it (fail closed).",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    orgId: z.string().min(1),
    name: z.string().min(1).max(100),
    repoOwner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
    repoName: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    defaultBranch: z.string().min(1).max(100).default("main"),
    githubInstallationId: z.string().regex(/^\d+$/).optional(),
  }),
  output: projectView,
  async handler(input, ctx) {
    const org = await ctx.db
      .selectFrom("core_organization")
      .select("id")
      .where("id", "=", input.orgId)
      .executeTakeFirst();
    if (!org) throw new OperationError("not_found", "no such org");
    let factory = await ctx.db
      .selectFrom("core_factories")
      .select("id")
      .where("org_id", "=", input.orgId)
      .orderBy("created_at")
      .executeTakeFirst();
    if (!factory) {
      factory = { id: newId("factory") };
      ctx.write(
        ctx.db.insertInto("core_factories").values({
          id: factory.id,
          org_id: input.orgId,
          name: "Default",
          created_at: ctx.now,
          created_by: ctx.actor.id,
        }),
      );
    }
    const id = newId("project");
    const slug = slugify(input.name);
    ctx.write(
      ctx.db.insertInto("core_projects").values({
        id,
        org_id: input.orgId,
        factory_id: factory.id,
        name: input.name,
        slug,
        repo_owner: input.repoOwner,
        repo_name: input.repoName,
        default_branch: input.defaultBranch,
        github_installation_id: input.githubInstallationId ?? null,
        created_at: ctx.now,
        created_by: ctx.actor.id,
      }),
    );
    ctx.change({
      entity: "project",
      id,
      after: { name: input.name, repo: `${input.repoOwner}/${input.repoName}` },
    });
    ctx.subject({ projectId: id, orgId: input.orgId });
    return {
      id,
      orgId: input.orgId,
      factoryId: factory.id,
      name: input.name,
      slug,
      repo: { owner: input.repoOwner, name: input.repoName, defaultBranch: input.defaultBranch },
      policySha: null,
      githubInstallationId: input.githubInstallationId ?? null,
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
    return {
      projects: rows.map((p) => ({
        id: p.id,
        orgId: p.org_id,
        factoryId: p.factory_id,
        name: p.name,
        slug: p.slug,
        repo: { owner: p.repo_owner, name: p.repo_name, defaultBranch: p.default_branch },
        policySha: p.policy_sha,
        githubInstallationId: p.github_installation_id,
      })),
    };
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
