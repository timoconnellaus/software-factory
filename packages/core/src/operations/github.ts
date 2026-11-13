// What the control plane does on GitHub through the App (ADR 0025, 0033, 0035): it owns the work
// item branch `factory/<n>-<slug>` (created from the default branch, moved only as a fast-forward to
// an accepted run's head), opens the PR and merges it after the merge gate. Runners only ever push
// their own run branch.
import { z } from "zod";
import { BABYSITTER } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { has } from "../workflow-features.ts";
import { AUTO_APPROVE, autoApprovedMergeLanded } from "./auto-approve.ts";
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

/** What a person sees when GitHub refuses an approved merge because the head moved meanwhile. */
export const BRANCH_MOVED_AFTER_APPROVAL =
  "the branch moved after you approved: review the new commit";

export const prMerge = defineOperation({
  name: "pr.merge",
  description:
    'Merge the work item\'s PR through the GitHub App. Risk `merge` (`self-modify` when the diff touches `.factory/`): always reviewed, for every actor and policy, so it opens the merge gate; it runs once a person approves with review.merge. Refused if the head moved since the packet was made, for an item that is no longer open (cancelled, done, failed), for a queued item unless it is the head of the merge queue at the head the queue recorded (ADR 0330), and for the babysitter unless the item\'s entry is still open in its queue (spec 53). When GitHub says the head moved after approval, the refusal carries `details.mergeRefused: "headMoved"`: on a call by the babysitter for a Workflow v11+ item the approval is left to the babysitter, which owns the moved head; otherwise (v10 and earlier, an attached PR) the approval is closed (review the new commit). Any other GitHub refusal carries `mergeRefused: "refused"`.',
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
    const github = ctx.services.github;
    // A PR GitHub already shows merged at this head was merged by a call that lost track of it (a
    // pass that died, or lost its lease, between GitHub's merge and its own record): it is recorded
    // as merged, not merged again; GitHub refuses a second merge (spec 53 review).
    const pr = await github.getPullRequest(repo, w.pr_number);
    let sha: string;
    if (pr?.merged) {
      if (pr.head.sha !== input.headSha || !pr.mergeCommitSha) {
        throw new OperationError(
          "conflict",
          `merge refused: #${w.pr_number} was already merged at ${pr.head.sha.slice(0, 7)}, not ${input.headSha.slice(0, 7)}`,
          { mergeRefused: "refused" },
        );
      }
      sha = pr.mergeCommitSha;
    } else {
      const merged = await github.mergePullRequest(repo, {
        number: w.pr_number,
        sha: input.headSha,
        method: "merge",
      });
      if (!merged.merged && merged.headMoved) {
        if (
          has(w.workflow_version, "babysitter-delivery") &&
          ctx.actor.type === BABYSITTER.type &&
          ctx.actor.id === BABYSITTER.id
        ) {
          // From v11 the babysitter owns a moved head (spec 53): it re-snapshots, re-verifies and
          // carries or withdraws the approval itself, so the approval is left for it to decide.
          // (Its call reached here only with the item's entry open in its queue.)
          throw new OperationError("conflict", `merge refused: ${merged.reason}`, {
            mergeRefused: "headMoved",
          });
        }
        // The branch moved after the engine's check above: the approval was for a commit that is
        // no longer the head. Say so, and close the approval (invoke does, for `closeApproval`),
        // so the gate doesn't stay "approved" for a commit that will never merge.
        throw new OperationError("conflict", BRANCH_MOVED_AFTER_APPROVAL, {
          closeApproval: true,
          mergeRefused: "headMoved",
        });
      }
      if (!merged.merged) {
        throw new OperationError("conflict", `merge refused: ${merged.reason}`, {
          mergeRefused: "refused",
        });
      }
      sha = merged.sha;
    }
    // From here the merge has happened. If a guard below fails the batch (a cancel, a takeover or a
    // leave that committed while GitHub merged), these still commit: merged wins over a cancel that
    // raced it, and the item is done with a note saying so (spec 53).
    ctx.happened(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "done",
          status_reason: "cancelled after its merge had started",
          updated_at: ctx.now,
        })
        .where("id", "=", w.id)
        .where("status", "=", "cancelled"),
    );
    ctx.happened(
      ctx.db
        .updateTable("core_merge_queue")
        .set({
          status: "merged",
          outcome: "merged",
          end_reason: "merged; the cancel that raced the merge came too late",
          updated_at: ctx.now,
        })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "left")
        .where("end_reason", "like", "cancelled:%")
        .where("ended_at", ">=", ctx.now),
    );
    ctx.change({ entity: "work_item", id: w.id, after: { merged: sha } });
    // Dark factory mode (ADR 0515): an auto-approved merge starts its red-main window at the merge
    // commit, is remembered for a revert, and may be sampled for a person's review after it.
    if (ctx.approval?.decided_by === AUTO_APPROVE.id)
      await autoApprovedMergeLanded(ctx, w, ctx.approval, sha);
    return { merged: true as const, sha };
  },
});
