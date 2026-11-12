// What the control plane does on GitHub through the App (ADR 0025, 0033, 0035): it owns the work
// item branch `factory/<n>-<slug>` (created from the default branch, moved only as a fast-forward to
// an accepted run's head), opens the PR and merges it after the merge gate. Runners only ever push
// their own run branch.
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { requireOpenToMerge, requireQueueHead } from "./merge-queue.ts";
import { repoRef, requireRepository, requireWorkItem, sha, workItemId } from "./shared.ts";

export const branchEnsure = defineOperation({
  name: "branch.ensure",
  description:
    "Create the work item's branch `factory/<n>-<slug>` from the default branch's head, through the GitHub App. A no-op when it exists.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ branch: z.string(), sha: z.string() }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    let head = await ctx.services.github.getBranchSha(repo, w.branch);
    if (!head) {
      const base = await ctx.services.github.getBranchSha(repo, repository.default_branch);
      if (!base)
        throw new OperationError(
          "unavailable",
          `no ${repository.default_branch} branch on ${repo.owner}/${repo.repo}`,
        );
      await ctx.services.github.createBranch(repo, w.branch, base);
      head = base;
      ctx.change({ entity: "branch", id: w.branch, after: { sha: base } });
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ head_sha: head, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    return { branch: w.branch, sha: head };
  },
});

export const branchAdvance = defineOperation({
  name: "branch.advance",
  description:
    "Fast-forward the work item's branch to a run's pushed head (ADR 0035). Only for a run that handed back with the current fencing token; anything that isn't a fast-forward is refused.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, runId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), sha: z.string().nullable(), reason: z.string().nullable() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const run = await ctx.db
      .selectFrom("core_runs")
      .selectAll()
      .where("id", "=", input.runId)
      .executeTakeFirst();
    if (!run || run.work_item_id !== w.id) throw new OperationError("not_found", "no such run");
    if (run.status !== "handed_back" || !run.head_sha) {
      return { ok: false, sha: null, reason: `run is ${run.status} with no pushed head` };
    }
    const lease = await ctx.db
      .selectFrom("core_leases")
      .select("fencing_token")
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    if (lease?.fencing_token !== run.fencing_token) {
      return { ok: false, sha: null, reason: "the run's fencing token is stale (taken over)" };
    }
    const repo = await repoRef(ctx, requireRepository(ctx));
    const moved = await ctx.services.github.fastForward(repo, w.branch, run.head_sha);
    if (!moved.ok) return { ok: false, sha: null, reason: moved.reason };
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ head_sha: run.head_sha, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    ctx.change({
      entity: "branch",
      id: w.branch,
      before: { sha: w.head_sha },
      after: { sha: run.head_sha },
    });
    return { ok: true, sha: run.head_sha, reason: null };
  },
});

export const prOpen = defineOperation({
  name: "pr.open",
  description:
    "Open (or find) the work item's pull request from its branch into the default branch, as the GitHub App. Risk `outbound`.",
  risk: "outbound",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, body: z.string().max(60_000).default("") }),
  output: z.object({
    number: z.number(),
    url: z.string(),
    /** Whether the branch's diff touches `.factory/`: its merge is then self-modify (ADR 0036). */
    touchesFactoryConfig: z.boolean(),
    changedFiles: z.number(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const files = await ctx.services.github.changedFiles(repo, repository.default_branch, w.branch);
    const touchesFactoryConfig = files.some((f) => f === ".factory" || f.startsWith(".factory/"));
    if (w.pr_number && w.pr_url) {
      return {
        number: w.pr_number,
        url: w.pr_url,
        touchesFactoryConfig,
        changedFiles: files.length,
      };
    }
    const pr = await ctx.services.github.openPullRequest(repo, {
      head: w.branch,
      base: repository.default_branch,
      title: w.title,
      body: input.body || `Work item #${w.number}, built by the software factory.`,
    });
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ pr_number: pr.number, pr_url: pr.url, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    ctx.change({ entity: "work_item", id: w.id, after: { pr: pr.url } });
    return { ...pr, touchesFactoryConfig, changedFiles: files.length };
  },
});

export const prMerge = defineOperation({
  name: "pr.merge",
  description:
    "Merge the work item's PR through the GitHub App. Risk `merge` (`self-modify` when the diff touches `.factory/`): always reviewed, for every actor and policy, so it opens the merge gate; it runs once a person approves with review.merge. Refused if the head moved since the packet was made, for an item that is no longer open (cancelled, done, failed), for a queued item unless it is the head of the merge queue at the head the queue recorded (ADR 0330), and for the babysitter unless the item's entry is still open in its queue (spec 53).",
  risk: "merge",
  riskOf: (input) => (input.touchesFactoryConfig ? "self-modify" : "merge"),
  actors: ["agent"],
  permission: "approver",
  gateKind: "merge",
  input: z.object({ workItemId, headSha: sha, touchesFactoryConfig: z.boolean() }),
  output: z.object({ merged: z.literal(true), sha: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (!w.pr_number) throw new OperationError("conflict", "no pull request");
    if (w.head_sha !== input.headSha) {
      throw new OperationError("conflict", "the branch moved since the review packet was made");
    }
    await requireQueueHead(ctx, w, input.headSha);
    // Only an open item merges, and the babysitter only an entry still in its queue (spec 53
    // review): read now, before GitHub is asked, and guarded again in this call's batch so a cancel
    // or a leave that commits in between refuses it.
    await requireOpenToMerge(ctx, w);
    const repo = await repoRef(ctx, requireRepository(ctx));
    const merged = await ctx.services.github.mergePullRequest(repo, {
      number: w.pr_number,
      sha: input.headSha,
      method: "merge",
    });
    if (!merged.merged) throw new OperationError("conflict", `merge refused: ${merged.reason}`);
    ctx.change({ entity: "work_item", id: w.id, after: { merged: merged.sha } });
    return { merged: true as const, sha: merged.sha };
  },
});
