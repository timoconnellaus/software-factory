// The verify stage's cloud half (spec 04, ADR 0020, 0037, 0041): read CI from GitHub on the head
// SHA, assemble the review packet, post `factory/verify` from the App for that SHA, re-evaluate it
// whenever CI or the PR changes, the onboarding check, and the check-only auto-merge (ADR 0230).
import { checkResultSchema } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { reviewerMatchesImplementer } from "../model-roles.ts";
import {
  defineOperation,
  type HandlerContext,
  type ProjectRow,
  type WorkItemRow,
} from "../operation.ts";
import type { ChangedFile, RepoRef } from "../services.ts";
import { checkOnlyDiff } from "../verify/auto-merge.ts";
import { type CiSummary, summarizeCi, VERIFY_CHECK_NAME } from "../verify/ci.ts";
import { assemblePacket, storedTestFindings, verifyCheckOutput } from "../verify/packet.ts";
import { testFindingLines } from "../verify/tests-intact.ts";
import { approvalEvent, ciEvent, type GateEventPayload, prHeadEvent } from "../workflow-events.ts";
import { requireQueueHead } from "./merge-queue.ts";
import { inspectProtection } from "./protection.ts";
import {
  cancelWorkItem,
  projectForRepo,
  projectId,
  repoName,
  repoRef,
  repositoryForRepo,
  requireProject,
  requireRepository,
  requireWorkItem,
  sha,
  workItemId,
} from "./shared.ts";

export { projectForRepo, repoName, repositoryForRepo };

async function readCi(ctx: HandlerContext, repo: RepoRef, headSha: string): Promise<CiSummary> {
  const gh = ctx.services.github;
  return summarizeCi(await gh.listCheckRuns(repo, headSha), gh.app.slug);
}

/**
 * Posts (or updates) `factory/verify` for one SHA and queues its row. A GitHub failure (the App
 * without `checks: write`, an outage) is returned, not thrown: the packet still records, and the
 * required check simply stays unpassed.
 */
export async function postVerify(
  ctx: HandlerContext,
  args: {
    project: ProjectRow;
    repo: RepoRef;
    headSha: string;
    item: Pick<WorkItemRow, "id" | "pr_number"> | null;
    /** The check's Details link, under the app's URL, when there is no item to link to. */
    detailsPath?: string;
    prNumber: number | null;
    packetId: string | null;
    output: {
      status: "queued" | "in_progress" | "completed";
      conclusion?: "success" | "failure";
      title: string;
      summary: string;
    };
  },
): Promise<{ checkRunId: string | null; error: string | null }> {
  // The repository the head is in (ADR 0490): the call's, from its work item or its webhook.
  const repositoryId = ctx.scope.repository?.id ?? null;
  const existing = await ctx.db
    .selectFrom("core_verify_checks")
    .selectAll()
    .where("project_id", "=", args.project.id)
    .where("head_sha", "=", args.headSha)
    .executeTakeFirst();
  const base = ctx.services.publicBaseUrl?.replace(/\/$/, "");
  let checkRunId = existing?.github_check_run_id ?? null;
  let error: string | null = null;
  try {
    const posted = await ctx.services.github.postCheckRun(args.repo, {
      name: VERIFY_CHECK_NAME,
      headSha: args.headSha,
      status: args.output.status,
      ...(args.output.conclusion ? { conclusion: args.output.conclusion } : {}),
      title: args.output.title,
      summary: args.output.summary,
      ...(base && args.item
        ? { detailsUrl: `${base}/work/${args.item.id}` }
        : base && args.detailsPath
          ? { detailsUrl: `${base}${args.detailsPath}` }
          : {}),
      ...(args.item ? { externalId: args.item.id } : {}),
      checkRunId,
    });
    checkRunId = posted.id;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const row = {
    work_item_id: args.item?.id ?? existing?.work_item_id ?? null,
    pr_number: args.prNumber ?? args.item?.pr_number ?? existing?.pr_number ?? null,
    github_check_run_id: checkRunId,
    status: args.output.status,
    conclusion: args.output.conclusion ?? null,
    title: args.output.title,
    review_packet_id: args.packetId ?? existing?.review_packet_id ?? null,
    updated_at: ctx.now,
    repository_id: repositoryId ?? existing?.repository_id ?? null,
  };
  ctx.write(
    ctx.db
      .insertInto("core_verify_checks")
      .values({ project_id: args.project.id, head_sha: args.headSha, ...row })
      .onConflict((oc) => oc.columns(["project_id", "head_sha"]).doUpdateSet(row)),
  );
  ctx.change({
    entity: "verify_check",
    id: `${args.project.id}:${args.headSha}`,
    before: existing ? { status: existing.status, conclusion: existing.conclusion } : null,
    after: { status: row.status, conclusion: row.conclusion, error },
  });
  return { checkRunId, error };
}

const reviewerSchema = z.object({
  role: z.literal("review"),
  model: z.string().optional(),
  verdict: z.enum(["approve", "request_changes"]),
  notes: z.string(),
  sameModelAsImplementer: z.boolean().default(false),
});

export const reviewPacketRecord = defineOperation({
  name: "reviewPacket.record",
  description:
    "Assemble and store the review packet for the work item's head SHA (ADR 0020, 0041), and post `factory/verify` for that SHA from the App (ADR 0037). The runner's report (criteria with evidence, its checks, the reviewer's verdict, risk flags) is evidence; the verdict passes only when CI on GitHub is green for the SHA AND the packet is complete (every criterion met with evidence, the reviewer approves, no runner check failing). Risk flags (auth, migrations, deps, `.factory/`, permissions) come from GitHub's compare, and so does the tests-intact guard (ADR 0500): deleted, removed, skipped or commented-out tests, new suppressions, lowered thresholds and gate-file edits are recorded as findings for a person, never judged by an agent and never part of the verdict. Returns the verdict.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    runId: z.string().nullable().default(null),
    headSha: sha,
    /** What the runner concluded. Kept in the packet; never the verdict (spec 04, criterion 9). */
    verdict: z.enum(["pass", "fail"]).optional(),
    summary: z.string().max(20_000).default(""),
    criteria: z
      .array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() }))
      .max(50)
      .default([]),
    checks: z.array(checkResultSchema).max(100).default([]),
    reviewer: reviewerSchema.nullable().default(null),
    riskFlags: z.array(z.string().max(500)).max(50).default([]),
    sections: z.record(z.string(), z.unknown()).default({}),
  }),
  output: z.object({
    reviewPacketId: z.string(),
    verdict: z.enum(["pass", "fail"]),
    ciState: z.enum(["success", "failure", "pending", "missing"]),
    reasons: z.array(z.string()),
    checkRunId: z.string().nullable(),
    checkError: z.string().nullable(),
    /** The tests-intact guard's findings for this SHA (ADR 0500), one line each. */
    testFindings: z.array(z.string()).default([]),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const ci = await readCi(ctx, repo, input.headSha);
    let files: ChangedFile[] | null = null;
    try {
      files = await ctx.services.github.compareFiles(
        repo,
        repository.default_branch,
        input.headSha,
      );
    } catch {
      files = null; // the packet is then incomplete, so it fails
    }
    const sameModel =
      (input.reviewer?.sameModelAsImplementer ?? false) ||
      reviewerMatchesImplementer(ctx.scope.policy?.modelRoles ?? {});
    const packet = assemblePacket({
      headSha: input.headSha,
      evidence: {
        summary: input.summary,
        criteria: input.criteria,
        checks: input.checks,
        reviewer: input.reviewer,
        riskFlags: input.riskFlags,
      },
      ci,
      files,
      sameModelAsImplementer: sameModel,
      runnerVerdict: input.verdict,
    });
    const id = newId("reviewPacket");
    ctx.write(
      ctx.db.insertInto("core_review_packets").values({
        id,
        work_item_id: w.id,
        run_id: input.runId,
        head_sha: input.headSha,
        verdict: packet.verdict,
        summary: input.summary,
        criteria: JSON.stringify(input.criteria),
        checks: JSON.stringify(input.checks),
        reviewer: input.reviewer
          ? JSON.stringify({ ...input.reviewer, sameModelAsImplementer: sameModel })
          : null,
        risk_flags: JSON.stringify(packet.riskFlags),
        sections: JSON.stringify({
          ...input.sections,
          ...packet.sections,
          warnings: packet.warnings,
        }),
        created_at: ctx.now,
      }),
    );
    ctx.change({
      entity: "review_packet",
      id,
      after: {
        verdict: packet.verdict,
        headSha: input.headSha,
        ci: ci.state,
        testsIntact: packet.testsIntact.intact,
        testFindings: packet.testsIntact.total,
      },
    });
    const posted = await postVerify(ctx, {
      project,
      repo,
      headSha: input.headSha,
      item: w,
      prNumber: w.pr_number,
      packetId: id,
      output: verifyCheckOutput({
        evidencePass: packet.evidencePass,
        evidenceReasons: packet.evidenceReasons,
        warnings: packet.warnings,
        riskFlags: packet.riskFlags,
        ci,
        workItem: w,
        testFindings: testFindingLines(packet.testsIntact.findings, packet.testsIntact.total),
        testFindingsTotal: packet.testsIntact.total,
      }),
    });
    return {
      reviewPacketId: id,
      verdict: packet.verdict,
      ciState: ci.state,
      reasons: packet.reasons,
      checkRunId: posted.checkRunId,
      checkError: posted.error,
      testFindings: testFindingLines(packet.testsIntact.findings, packet.testsIntact.total),
    };
  },
});

export const ciRead = defineOperation({
  name: "ci.read",
  description:
    "Read CI on GitHub for a work item's head SHA: the check runs other than the factory's own, and their state (success, failure, pending, missing). Also whether GitHub can merge the item's PR into the default branch (`mergeable`: false means conflicts, and GitHub then runs no `pull_request` CI at all; null means unknown or still computing). The Workflow waits on this before it assembles the review packet.",
  risk: "read",
  actors: ["agent", "human"],
  permission: "member",
  input: z.object({ workItemId, headSha: sha }),
  output: z.object({
    state: z.enum(["success", "failure", "pending", "missing"]),
    failing: z.array(z.string()),
    pending: z.array(z.string()),
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        url: z.string().nullable(),
      }),
    ),
    /** Added by ADR 0320; v2 Workflow instances ignore it. */
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const repo = await repoRef(ctx, requireRepository(ctx));
    const ci = await readCi(ctx, repo, input.headSha);
    return { ...ci, ...(await readMergeability(ctx, repo, w.pr_number, input.headSha)) };
  },
});

/**
 * Whether the item's PR can merge (ADR 0320). Unknown (null) when there's no PR, GitHub is still
 * computing it, its head isn't `headSha` yet, or GitHub can't be read: never a guess.
 */
async function readMergeability(
  ctx: HandlerContext,
  repo: RepoRef,
  prNumber: number | null,
  headSha: string,
): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
  if (!prNumber) return { mergeable: null, mergeableState: null };
  try {
    const pr = await ctx.services.github.pullRequestMergeability(repo, prNumber);
    if (pr.headSha && pr.headSha !== headSha) return { mergeable: null, mergeableState: "stale" };
    return { mergeable: pr.mergeable, mergeableState: pr.mergeableState };
  } catch {
    return { mergeable: null, mergeableState: null };
  }
}

export const verifyRefresh = defineOperation({
  name: "verify.refresh",
  description:
    "Re-evaluate `factory/verify` for one commit of a project's repo, from the newest review packet for it and CI as it stands on GitHub (ADR 0037). Called by the GitHub connector when a PR opens or gets a new push, when a check suite completes, or when someone re-runs the check. A new head with no packet yet is left without a passing check; a PR the factory didn't open fails until it is attached to a work item (spec 04, criterion 3), and its check links to the app's `/attach` page (spec 05). For an attached PR, a new push records the new head, withdraws a pending merge gate and wakes the Workflow to verify again; closing it without merging cancels its item. Wakes a Workflow waiting on CI.",
  risk: "write",
  actors: ["intake", "agent"],
  permission: "signed-in",
  allowWhenKilled: true,
  input: z.object({
    repo: repoName,
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    prNumber: z.number().int().positive().nullable().default(null),
    trigger: z.enum(["pull_request", "ci", "rerequested", "closed"]),
    /** With `closed`: whether the PR was merged. */
    merged: z.boolean().default(false),
  }),
  output: z.object({
    outcome: z.enum(["posted", "unattached", "ignored", "cancelled"]),
    workItemId: z.string().nullable(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    ciState: z.string().nullable(),
  }),
  scope: async (input, db) => repositoryForRepo(db, input.repo),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const none = { workItemId: null, status: null, conclusion: null, ciState: null };
    const byPr = async () =>
      input.prNumber
        ? ((await ctx.db
            .selectFrom("core_work_items")
            .selectAll()
            // A PR number is per repository (ADR 0490): B#5 is not A#5.
            .where("repository_id", "=", repository.id)
            .where("pr_number", "=", input.prNumber)
            .orderBy("updated_at", "desc")
            .executeTakeFirst()) ?? null)
        : null;

    if (input.trigger === "closed") {
      // Only an attached PR's item ends with its PR; the factory's own items end in the Workflow.
      const item = await byPr();
      if (
        item?.kind !== "attached" ||
        input.merged ||
        !["running", "waiting", "paused"].includes(item.status)
      ) {
        return { outcome: "ignored" as const, ...none, workItemId: item?.id ?? null };
      }
      ctx.subject({ workItemId: item.id });
      cancelWorkItem(ctx, item, "the pull request was closed without merging");
      return { outcome: "cancelled" as const, ...none, workItemId: item.id };
    }

    const existing = await ctx.db
      .selectFrom("core_verify_checks")
      .select(["status", "work_item_id"])
      .where("project_id", "=", project.id)
      .where((eb) =>
        eb.or([eb("repository_id", "=", repository.id), eb("repository_id", "is", null)]),
      )
      .where("head_sha", "=", input.headSha)
      .executeTakeFirst();
    let item =
      (await ctx.db
        .selectFrom("core_work_items")
        .selectAll()
        .where("repository_id", "=", repository.id)
        .where("head_sha", "=", input.headSha)
        .orderBy("updated_at", "desc")
        .executeTakeFirst()) ?? null;
    item ??= await byPr();
    if (!item && existing?.work_item_id) {
      // An earlier head of an item: its check stays what its own packet says (ADR 0037).
      item =
        (await ctx.db
          .selectFrom("core_work_items")
          .selectAll()
          .where("id", "=", existing.work_item_id)
          .executeTakeFirst()) ?? null;
    }

    // An attached item that ended without merging (its PR closed, or it was cancelled) no longer
    // owns the PR: reopened, it reads as unattached again and can be attached anew.
    if (item?.kind === "attached" && ["cancelled", "failed", "rejected"].includes(item.status)) {
      item = null;
    }
    if (!item) {
      if (!input.prNumber && !existing) return { outcome: "ignored" as const, ...none };
      const output = {
        status: "completed" as const,
        conclusion: "failure" as const,
        title: "Not attached to a factory work item",
        summary:
          "This pull request wasn't opened by the factory, so nothing has verified it. Attach it to a work item (Details → **Attach and verify**) and the factory will verify this commit. Nothing reaches the default branch except through `factory/verify` (ADR 0020, 0021).",
      };
      const prNumber = input.prNumber ?? null;
      await postVerify(ctx, {
        project,
        repo,
        headSha: input.headSha,
        item: null,
        ...(prNumber
          ? {
              detailsPath: `/attach?repo=${encodeURIComponent(`${repository.owner}/${repository.name}`)}&pr=${prNumber}`,
            }
          : {}),
        prNumber,
        packetId: null,
        output,
      });
      return {
        outcome: "unattached" as const,
        workItemId: null,
        status: output.status,
        conclusion: output.conclusion,
        ciState: null,
      };
    }
    ctx.subject({ workItemId: item.id });

    if (
      item.kind === "attached" &&
      input.trigger === "pull_request" &&
      input.prNumber !== null &&
      input.prNumber === item.pr_number &&
      item.head_sha !== input.headSha &&
      ["running", "waiting", "paused"].includes(item.status)
    ) {
      // A push to an attached PR (spec 05). GitHub says what the head is now, so a late delivery
      // for an older push can't move the item back.
      const pr = await ctx.services.github.getPullRequest(repo, input.prNumber);
      if (pr?.state === "open" && pr.head.sha === input.headSha) {
        item = await moveAttachedHead(ctx, item, input.headSha);
      }
    }

    const ci = await readCi(ctx, repo, input.headSha);
    const packet = await ctx.db
      .selectFrom("core_review_packets")
      .select(["id", "sections", "risk_flags"])
      .where("work_item_id", "=", item.id)
      .where("head_sha", "=", input.headSha)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    // Wake a Workflow that waits for CI on this SHA (v2 verify), once CI has settled.
    // ...and one in the merge queue waiting for CI after it brought the branch up to date (ADR 0330).
    if (
      ci.state !== "pending" &&
      item.head_sha === input.headSha &&
      (item.stage === "verify" || item.stage === "merge")
    ) {
      ctx.emit({
        kind: "workflow.event",
        payload: {
          instanceId: item.workflow_id,
          type: ciEvent(item.id, input.headSha),
          payload: { state: ci.state },
        },
      });
    }
    // ...and the babysitter's deliverer, when the head it brought up to date has settled (spec 53).
    if (ci.state !== "pending" && item.stage === "merge") {
      const delivering = await ctx.db
        .selectFrom("core_merge_queue")
        .select("id")
        .where("work_item_id", "=", item.id)
        .where("status", "=", "queued")
        .where("driver", "=", "babysitter")
        .where("head_sha", "=", input.headSha)
        .executeTakeFirst();
      if (delivering) {
        ctx.emit({
          kind: "delivery.wake",
          payload: { projectId: item.project_id, repositoryId: item.repository_id },
        });
      }
    }

    let output: Parameters<typeof postVerify>[1]["output"];
    if (packet) {
      const sections = parseObject(packet.sections);
      output = verifyCheckOutput({
        evidencePass: sections.evidencePass === true,
        evidenceReasons: strings(sections.evidenceReasons),
        warnings: strings(sections.warnings),
        riskFlags: strings(parseJson(packet.risk_flags)),
        ci,
        workItem: item,
        ...storedTestFindings(sections),
      });
    } else if (input.trigger === "ci" && existing) {
      // CI moved, but verify hasn't run on this SHA yet: the check already says so.
      return {
        outcome: "ignored" as const,
        workItemId: item.id,
        status: existing.status,
        conclusion: null,
        ciState: ci.state,
      };
    } else if (input.trigger === "ci") {
      return { outcome: "ignored" as const, ...none, workItemId: item.id, ciState: ci.state };
    } else if (item.head_sha === input.headSha) {
      output = {
        status: "in_progress",
        title: "The factory is verifying this commit",
        summary: `Work item #${item.number}: ${item.title}\n\nVerify hasn't finished on this commit yet.`,
      };
    } else {
      output = {
        status: "completed",
        conclusion: "failure",
        title: "Verify hasn't run on this commit",
        summary: `Work item #${item.number}: ${item.title}\n\nThis commit isn't the head the factory verified (${item.head_sha?.slice(0, 7) ?? "none yet"}). A new push needs verify to run again (ADR 0037).`,
      };
    }
    await postVerify(ctx, {
      project,
      repo,
      headSha: input.headSha,
      item,
      prNumber: input.prNumber,
      packetId: packet?.id ?? null,
      output,
    });
    return {
      outcome: "posted" as const,
      workItemId: item.id,
      status: output.status,
      conclusion: output.conclusion ?? null,
      ciState: ci.state,
    };
  },
});

/**
 * Records an attached PR's new head (spec 05): the item runs again, a merge gate still open for
 * the old head is withdrawn (its approval can no longer merge anything), and the Workflow is woken
 * with `pr-head-<item>` to verify the new head. Returns the item as it now stands.
 */
async function moveAttachedHead(
  ctx: HandlerContext,
  item: WorkItemRow,
  headSha: string,
): Promise<WorkItemRow> {
  const gates = await ctx.db
    .selectFrom("core_pending_actions")
    .select(["id", "workflow_id"])
    .where("work_item_id", "=", item.id)
    .where("kind", "=", "merge")
    .where("status", "=", "pending")
    .execute();
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set((eb) => ({
        head_sha: headSha,
        status: eb
          .case()
          .when("status", "=", "waiting")
          .then("running" as const)
          .else(eb.ref("status"))
          .end(),
        status_reason: eb
          .case()
          .when("status", "=", "waiting")
          .then(null)
          .else(eb.ref("status_reason"))
          .end(),
        updated_at: ctx.now,
      }))
      .where("id", "=", item.id),
  );
  const note = `withdrawn: the pull request's head moved to ${headSha.slice(0, 7)}, so the factory verifies it again`;
  ctx.write(
    ctx.db
      .updateTable("core_pending_actions")
      .set({
        status: "rejected",
        decision: "withdrawn",
        decided_at: ctx.now,
        decided_by: ctx.actor.id,
        note,
      })
      .where("work_item_id", "=", item.id)
      .where("kind", "=", "merge")
      .where("status", "=", "pending"),
  );
  for (const gate of gates) {
    if (!gate.workflow_id) continue;
    const payload: GateEventPayload = { decision: "withdrawn", note, by: ctx.actor.id };
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: gate.workflow_id,
        type: approvalEvent(gate.id),
        payload: { ...payload },
      },
    });
  }
  ctx.emit({
    kind: "workflow.event",
    payload: { instanceId: item.workflow_id, type: prHeadEvent(item.id), payload: { headSha } },
  });
  ctx.change({
    entity: "work_item",
    id: item.id,
    before: { headSha: item.head_sha },
    after: { headSha, reason: "a push to the attached pull request" },
  });
  return {
    ...item,
    head_sha: headSha,
    status: item.status === "waiting" ? "running" : item.status,
  };
}

/**
 * The merge queue brought a verified head up to date with the default branch by a clean merge
 * (ADR 0330): the reviewed diff is unchanged, so the review packet carries over to the new head,
 * marked with where it came from. `factory/verify` on the new head then passes only on green CI
 * there, like any packet.
 */
export async function carryReviewPacket(
  ctx: HandlerContext,
  args: { item: WorkItemRow; project: ProjectRow; repo: RepoRef; fromSha: string; toSha: string },
): Promise<{ packetId: string | null }> {
  const from = await ctx.db
    .selectFrom("core_review_packets")
    .selectAll()
    .where("work_item_id", "=", args.item.id)
    .where("head_sha", "=", args.fromSha)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!from) return { packetId: null };
  const sections: Record<string, unknown> = {
    ...parseObject(from.sections),
    carriedFrom: args.fromSha,
  };
  const id = newId("reviewPacket");
  ctx.write(
    ctx.db.insertInto("core_review_packets").values({
      id,
      work_item_id: args.item.id,
      run_id: from.run_id,
      head_sha: args.toSha,
      verdict: from.verdict,
      summary: from.summary,
      criteria: from.criteria,
      checks: from.checks,
      reviewer: from.reviewer,
      risk_flags: from.risk_flags,
      sections: JSON.stringify(sections),
      created_at: ctx.now,
    }),
  );
  ctx.change({
    entity: "review_packet",
    id,
    after: { headSha: args.toSha, carriedFrom: args.fromSha },
  });
  const ci = await readCi(ctx, args.repo, args.toSha);
  await postVerify(ctx, {
    project: args.project,
    repo: args.repo,
    headSha: args.toSha,
    item: args.item,
    prNumber: args.item.pr_number,
    packetId: id,
    output: verifyCheckOutput({
      evidencePass: sections.evidencePass === true,
      evidenceReasons: strings(sections.evidenceReasons),
      warnings: strings(sections.warnings),
      riskFlags: strings(parseJson(from.risk_flags)),
      ci,
      workItem: args.item,
      ...storedTestFindings(sections),
    }),
  });
  return { packetId: id };
}

export const prAutoMerge = defineOperation({
  name: "pr.autoMerge",
  description:
    "Merge a factory incident's fix without a person, under the narrow check-only rule (ADR 0230): the item is a factory incident, GitHub's compare shows it only ADDS files under `.factory/checks/` and `evals/regressions/` (with at least one regression case), CI is green on the head SHA (the regression eval runs there), the review packet for that SHA passed, and its tests-intact guard found nothing (ADR 0500). Risk `check-merge`, which every autonomy policy denies unless the project's `.factory/policy.json` opts in. Anything else is refused: use pr.merge and the merge gate.",
  risk: "check-merge",
  actors: ["agent"],
  permission: "approver",
  gateKind: "merge",
  input: z.object({ workItemId, headSha: sha }),
  output: z.object({ merged: z.literal(true), sha: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const refuse = (reason: string): never => {
      throw new OperationError("denied", `not check-only: ${reason}`);
    };
    if (w.kind !== "incident") refuse("only a factory incident's fix may auto-merge");
    if (!w.pr_number) throw new OperationError("conflict", "no pull request");
    if (w.head_sha !== input.headSha) {
      throw new OperationError("conflict", "the branch moved since the review packet was made");
    }
    await requireQueueHead(ctx, w, input.headSha);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const files = await ctx.services.github.compareFiles(
      repo,
      repository.default_branch,
      input.headSha,
    );
    const diff = checkOnlyDiff(files);
    if (!diff.ok) refuse(diff.reason);
    const ci = await readCi(ctx, repo, input.headSha);
    if (ci.state !== "success") refuse(`CI is ${ci.state} on ${input.headSha.slice(0, 7)}`);
    const packet = await ctx.db
      .selectFrom("core_review_packets")
      .select(["verdict", "sections"])
      .where("work_item_id", "=", w.id)
      .where("head_sha", "=", input.headSha)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (packet?.verdict !== "pass") refuse("the review packet for this commit didn't pass");
    // The tests-intact guard (ADR 0500): any finding goes to a person, never auto-merges. A packet
    // from before the guard has no section, and is treated as not known to be intact.
    const intact = parseObject(packet?.sections ?? null).testsIntact as
      | { intact?: unknown; findings?: unknown[] }
      | undefined;
    if (intact?.intact !== true) {
      refuse(
        intact
          ? `the tests aren't intact on ${input.headSha.slice(0, 7)} (${intact.findings?.length ?? 0} finding(s)): a person decides`
          : "the review packet has no tests-intact check: a person decides",
      );
    }
    const merged = await ctx.services.github.mergePullRequest(repo, {
      number: w.pr_number,
      sha: input.headSha,
      method: "merge",
    });
    if (!merged.merged) throw new OperationError("conflict", `merge refused: ${merged.reason}`);
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { merged: merged.sha, auto: "check-only (ADR 0230)", files: files.map((f) => f.path) },
    });
    return { merged: true as const, sha: merged.sha };
  },
});

export const projectCheckGitHub = defineOperation({
  name: "project.checkGitHub",
  description:
    "The onboarding check (spec 04, ADR 0280): do the rules in force on the project's default branch match the generated ruleset (a PR, `ci` and `factory/verify` pinned to the factory's App, strict, no force pushes, no deletion, nobody bypassing), and does an active ruleset confine App pushes to `factory/*` (ADR 0052)? Returns the problems without recording them (protection.check records).",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({ ok: z.boolean(), problems: z.array(z.string()) }),
  async handler(_input, ctx) {
    const { verdict } = await inspectProtection(ctx, requireProject(ctx), requireRepository(ctx));
    return { ok: verdict.ok, problems: verdict.problems };
  },
});

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function parseObject(text: string | null): Record<string, unknown> {
  const v = parseJson(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
