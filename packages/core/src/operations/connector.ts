// The GitHub connector's operations (ADR 0010, 0036, 0052): the delivery log that dedupes
// webhooks, push validation (branch confinement and the default-branch policy mirror) and the App's
// installations. The connector (`packages/connector-github`, mounted by sf-engine) calls these as
// `{ type: "intake", id: "github" }`; it writes nothing itself.
import { sql } from "kysely";
import { z } from "zod";
import { defineOperation, type HandlerContext, type WorkItemRow } from "../operation.ts";
import { POLICY_PATH } from "../policy/project-policy.ts";
import { recordPolicy } from "./projects.ts";
import { ACTIVE_RUN, finishRun } from "./runners.ts";
import { repoRef, requireProject } from "./shared.ts";
import { projectForRepo, repoName } from "./verify.ts";

export const connectorReceive = defineOperation({
  name: "connector.receive",
  description:
    "Record one webhook delivery by provider and delivery id, after the connector has handled it. Returns `duplicate: true` when it was already recorded (a redelivery), so the connector does nothing twice.",
  risk: "write",
  actors: ["intake"],
  permission: "signed-in",
  allowWhenKilled: true,
  input: z.object({
    provider: z.enum(["github"]),
    deliveryId: z.string().min(1).max(100),
    event: z.string().min(1).max(100),
    action: z.string().max(100).nullable().default(null),
    repo: z.string().max(200).nullable().default(null),
  }),
  output: z.object({ duplicate: z.boolean() }),
  async handler(input, ctx) {
    const seen = await ctx.db
      .selectFrom("core_connector_events")
      .select("delivery_id")
      .where("provider", "=", input.provider)
      .where("delivery_id", "=", input.deliveryId)
      .executeTakeFirst();
    if (seen) return { duplicate: true };
    // No ON CONFLICT: a concurrent duplicate fails the batch as a conflict, which the connector
    // treats as "already handled".
    ctx.write(
      ctx.db.insertInto("core_connector_events").values({
        provider: input.provider,
        delivery_id: input.deliveryId,
        event: input.event,
        action: input.action,
        repo: input.repo,
        received_at: ctx.now,
      }),
    );
    return { duplicate: false };
  },
});

const RUN_BRANCH = /^factory\/(\d+)-[a-z0-9-]+-run-(\d+)$/;
const ITEM_BRANCH = /^factory\/(\d+)-[a-z0-9-]+$/;
const ZERO_SHA = /^0{40}$/;

type RunRow = {
  id: string;
  job_id: string;
  work_item_id: string;
  branch: string;
  status: string;
  fencing_token: number;
  head_sha: string | null;
};

export const pushObserve = defineOperation({
  name: "push.observe",
  description:
    "The GitHub connector saw a push. To the default branch: mirror `.factory/policy.json` at the new head (ADR 0036). By the factory's App anywhere else (branch confinement, ADR 0052 item 4): a push must be to the run branch of an active run whose fencing token is current, or a control-plane move of a work item's branch; anything else fails the work item's active run (bumping its fencing token) and is audited. People's pushes to other branches are ignored here (`factory/verify` guards their PRs).",
  risk: "write",
  actors: ["intake"],
  permission: "signed-in",
  // The default-branch push is how a policy arrives, so a missing one can't block it; and pushes
  // are still observed while a kill switch is on.
  bootstrapsPolicy: true,
  allowWhenKilled: true,
  input: z.object({
    repo: repoName,
    ref: z.string().min(1).max(300),
    before: z.string().regex(/^[0-9a-f]{40}$/),
    after: z.string().regex(/^[0-9a-f]{40}$/),
    pusher: z.string().max(200),
    pusherIsApp: z.boolean(),
  }),
  output: z.object({
    outcome: z.enum(["policy", "ok", "violation", "ignored"]),
    detail: z.string(),
    failedRuns: z.array(z.string()),
    policy: z
      .object({ applied: z.boolean(), valid: z.boolean(), error: z.string().nullable() })
      .nullable(),
  }),
  scope: async (input, db) => ({ projectId: await projectForRepo(db, input.repo) }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const none = { failedRuns: [] as string[], policy: null };
    if (!input.ref.startsWith("refs/heads/")) {
      return { outcome: "ignored" as const, detail: `not a branch: ${input.ref}`, ...none };
    }
    const branch = input.ref.slice("refs/heads/".length);
    if (ZERO_SHA.test(input.after)) {
      return { outcome: "ignored" as const, detail: `${branch} deleted`, ...none };
    }

    if (branch === project.default_branch) {
      const repo = await repoRef(ctx, project);
      const content = await ctx.services.github.readFile(repo, POLICY_PATH, input.after);
      const policy = recordPolicy(ctx, project, { ref: input.ref, sha: input.after, content });
      return {
        outcome: "policy" as const,
        detail: policy.valid ? "policy synced" : `policy invalid: ${policy.error}`,
        failedRuns: [],
        policy,
      };
    }
    if (!input.pusherIsApp) {
      return { outcome: "ignored" as const, detail: `pushed by ${input.pusher}`, ...none };
    }

    // A push by the App outside the default branch: a run branch, or a work item's branch.
    const runMatch = RUN_BRANCH.exec(branch);
    const itemMatch = runMatch ? null : ITEM_BRANCH.exec(branch);
    const number = Number((runMatch ?? itemMatch)?.[1] ?? Number.NaN);
    const item = Number.isFinite(number)
      ? ((await ctx.db
          .selectFrom("core_work_items")
          .selectAll()
          .where("project_id", "=", project.id)
          .where("number", "=", number)
          .executeTakeFirst()) ?? null)
      : null;
    if (!item) {
      // The ruleset should have stopped this; nothing of ours to fail, but it is on the record.
      return {
        outcome: "violation" as const,
        detail: `the App pushed ${branch}, which belongs to no work item`,
        ...none,
      };
    }
    ctx.subject({ workItemId: item.id });
    const lease = await ctx.db
      .selectFrom("core_leases")
      .select(["fencing_token", "holder_id"])
      .where("work_item_id", "=", item.id)
      .executeTakeFirst();
    const runs: RunRow[] = await ctx.db
      .selectFrom("core_runs")
      .select(["id", "job_id", "work_item_id", "branch", "status", "fencing_token", "head_sha"])
      .where("work_item_id", "=", item.id)
      .execute();
    const active = runs.filter((r) => (ACTIVE_RUN as readonly string[]).includes(r.status));

    if (runMatch) {
      const run = runs.find((r) => r.branch === branch);
      const current =
        run &&
        active.includes(run) &&
        lease?.fencing_token === run.fencing_token &&
        lease?.holder_id === run.id;
      if (current)
        return { outcome: "ok" as const, detail: `run ${run.id} pushed its branch`, ...none };
      const why = !run
        ? `the App pushed ${branch}, which is no run's branch`
        : active.includes(run)
          ? `run ${run.id} pushed ${branch} with a stale fencing token`
          : `the App pushed ${branch} after run ${run.id} ended (${run.status})`;
      return violation(ctx, item, active, why);
    }

    // The work item's branch moves only by the control plane (ADR 0052 item 3): to a handed-back
    // run's head, or a spec commit. A head no handed-back run had, while a run is active, is a run
    // pushing where it may not.
    const accepted = runs.some((r) => r.status === "handed_back" && r.head_sha === input.after);
    if (accepted || item.head_sha === input.after || active.length === 0) {
      return {
        outcome: "ok" as const,
        detail: accepted ? "advanced to a handed-back run" : "a control-plane move",
        ...none,
      };
    }
    return violation(
      ctx,
      item,
      active,
      `the App pushed the work item's branch ${branch} to ${input.after.slice(0, 7)}, which only the control plane moves`,
    );
  },
});

/** Fails the item's active runs (fencing them out) and tells the requester. */
function violation(ctx: HandlerContext, item: WorkItemRow, active: RunRow[], why: string) {
  for (const run of active) {
    ctx.write(
      ctx.db
        .updateTable("core_leases")
        .set((eb) => ({
          fencing_token: eb("fencing_token", "+", 1),
          holder_kind: null,
          holder_id: null,
          released_at: ctx.now,
        }))
        .where("work_item_id", "=", item.id)
        .where("fencing_token", "=", run.fencing_token),
    );
    finishRun(ctx, run, item.workflow_id, "failed", "failed", {
      reason: `branch confinement (ADR 0052): ${why}; the run pushed outside its own branch`,
    });
  }
  ctx.emit({
    kind: "notify",
    payload: {
      event: "run.confinement",
      userId: item.requester_user_id,
      workItemId: item.id,
      title: `A push outside the run's branch was stopped: #${item.number}`,
      url: `/work/${item.id}`,
    },
  });
  return {
    outcome: "violation" as const,
    detail: why,
    failedRuns: active.map((r) => r.id),
    policy: null,
  };
}

export const githubInstallation = defineOperation({
  name: "github.installation",
  description:
    "The factory's GitHub App was installed on, or removed from, an account's repositories (ADR 0025). Points matching projects at the installation, or clears it, so job tokens and PRs use the right one.",
  risk: "write",
  actors: ["intake"],
  permission: "signed-in",
  allowWhenKilled: true,
  input: z.object({
    action: z.enum(["added", "removed"]),
    installationId: z.string().regex(/^\d+$/),
    account: z.string().min(1).max(100),
    /** Repo names; null means every repo of the account. */
    repositories: z.array(z.string()).nullable(),
  }),
  output: z.object({ projects: z.number() }),
  async handler(input, ctx) {
    let q = ctx.db
      .selectFrom("core_projects")
      .select(["id", "repo_name", "github_installation_id"])
      .where(sql<string>`lower(repo_owner)`, "=", input.account.toLowerCase());
    if (input.repositories) {
      const names = input.repositories.map((r) => r.toLowerCase());
      if (names.length === 0) return { projects: 0 };
      q = q.where(sql<string>`lower(repo_name)`, "in", names);
    }
    const projects = await q.execute();
    let n = 0;
    for (const p of projects) {
      const next = input.action === "added" ? input.installationId : null;
      if (input.action === "removed" && p.github_installation_id !== input.installationId) continue;
      if (p.github_installation_id === next) continue;
      ctx.write(
        ctx.db
          .updateTable("core_projects")
          .set({ github_installation_id: next })
          .where("id", "=", p.id),
      );
      ctx.change({
        entity: "project",
        id: p.id,
        before: { installation: p.github_installation_id },
        after: { installation: next },
      });
      n++;
    }
    return { projects: n };
  },
});
