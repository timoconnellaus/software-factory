// Attaching an outside pull request to a work item (spec 05, ADR 0290). A PR opened by a local
// session or a person gets a work item of kind `attached`; its Workflow triages it, skips spec and
// build, and verifies the PR's own head, so the PR reaches the default branch through
// `factory/verify` and the merge gate like everything else. The factory never pushes to its branch.
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext, type RepositoryRow } from "../operation.ts";
import type { PullRequestInfo } from "../services.ts";
import { prHeadEvent } from "../workflow-events.ts";
import {
  createWorkItem,
  projectId,
  repoName,
  repoRef,
  repositoryForRepo,
  repositoryId,
  requireProject,
  requireRepository,
  requireWorkItem,
  sha,
  workItemId,
} from "./shared.ts";
import { postVerify } from "./verify.ts";

/** The intake dedupe key for a PR: one work item per PR. */
export const attachKey = (repository: Pick<RepositoryRow, "owner" | "name">, n: number) =>
  `github:${repository.owner}/${repository.name}#${n}`.toLowerCase();

/** Statuses of an item that still owns its PR: attaching again returns it. */
const LIVE = ["running", "waiting", "paused", "done"] as const;

/** Why a PR can't be attached, or null when it can. */
export function attachRefusal(
  repository: Pick<RepositoryRow, "owner" | "name" | "default_branch">,
  pr: PullRequestInfo,
): string | null {
  const repo = `${repository.owner}/${repository.name}`;
  if (pr.merged) return `#${pr.number} is already merged`;
  if (pr.state !== "open") return `#${pr.number} is closed`;
  if (pr.head.repo?.toLowerCase() !== repo.toLowerCase()) {
    return `#${pr.number} is from a fork (${pr.head.repo ?? "a deleted repository"}): only pull requests from ${repo} itself can be attached`;
  }
  if (pr.head.ref.startsWith("factory/")) {
    return `#${pr.number} is on a factory branch (${pr.head.ref}): the factory opened it, so it already has a work item`;
  }
  if (pr.base.ref !== repository.default_branch) {
    return `#${pr.number} targets ${pr.base.ref}, not ${repository.default_branch}: only pull requests into the default branch go through the merge gate`;
  }
  return null;
}

/** The live work item already attached to a PR, if there is one. */
async function attachedItem(ctx: HandlerContext, repository: RepositoryRow, prNumber: number) {
  return (
    (await ctx.db
      .selectFrom("core_intake_keys")
      .innerJoin("core_work_items", "core_work_items.id", "core_intake_keys.work_item_id")
      .select([
        "core_work_items.id",
        "core_work_items.number",
        "core_work_items.branch",
        "core_work_items.status",
      ])
      .where("core_intake_keys.dedupe_key", "=", attachKey(repository, prNumber))
      .executeTakeFirst()) ?? null
  );
}

async function readPull(ctx: HandlerContext, repository: RepositoryRow, prNumber: number) {
  const repo = await repoRef(ctx, repository);
  const pr = await ctx.services.github.getPullRequest(repo, prNumber);
  if (!pr) {
    throw new OperationError(
      "not_found",
      `no pull request #${prNumber} on ${repository.owner}/${repository.name}`,
    );
  }
  return { repo, pr };
}

const pullView = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  branch: z.string(),
  headSha: z.string(),
  draft: z.boolean(),
  /** Why it can't be attached; null when it can. */
  refusal: z.string().nullable(),
});
const view = (
  repository: RepositoryRow,
  pr: PullRequestInfo,
): z.input<typeof pullView> & { body: string } => ({
  number: pr.number,
  url: pr.url,
  title: pr.title,
  body: pr.body,
  author: pr.author,
  branch: pr.head.ref,
  headSha: pr.head.sha,
  draft: pr.draft,
  refusal: attachRefusal(repository, pr),
});

export const workItemAttachPr = defineOperation({
  name: "workItem.attachPr",
  description:
    "Attach a pull request opened outside the factory (by a local session or a person) to a new work item of kind `attached`, and start its Workflow: triage drafts acceptance criteria from the PR's title, body and diff, spec and build are skipped, verify runs on the PR's own head, and a pass opens the merge gate (spec 05, ADR 0290). The factory never pushes to the PR's branch; a new push re-verifies. Idempotent: attaching an attached PR returns its item with `outcome: \"attached\"`. Refused for a fork, a closed or merged PR, a factory branch (`factory/*`), a PR not into the default branch, and a project with no valid policy.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({
    projectId,
    /** Needed only when the project has several repositories (ADR 0440). */
    repositoryId: repositoryId.optional(),
    prNumber: z.number().int().positive(),
  }),
  output: z.object({
    workItemId: z.string(),
    number: z.number(),
    branch: z.string(),
    outcome: z.enum(["created", "attached"]),
  }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    if (!ctx.scope.policy) {
      throw new OperationError(
        "unavailable",
        `project ${project.name} has no valid config (${ctx.scope.policyError}); agents can't work on it`,
      );
    }
    const repository = requireRepository(ctx);
    const existing = await attachedItem(ctx, repository, input.prNumber);
    if (existing && (LIVE as readonly string[]).includes(existing.status)) {
      ctx.subject({ workItemId: existing.id });
      return {
        workItemId: existing.id,
        number: existing.number,
        branch: existing.branch,
        outcome: "attached" as const,
      };
    }
    const { repo, pr } = await readPull(ctx, repository, input.prNumber);
    const refusal = attachRefusal(repository, pr);
    if (refusal) throw new OperationError("denied", `can't attach ${refusal}`);

    const dedupeKey = attachKey(repository, pr.number);
    const title = pr.title.trim().slice(0, 200) || `Pull request #${pr.number}`;
    const created = createWorkItem(ctx, {
      project,
      repositoryId: repository.id,
      title,
      body: pr.body.slice(0, 50_000),
      source: "pr",
      kind: "attached",
      requesterUserId: ctx.actor.id,
      number: project.next_number,
      pr: { branch: pr.head.ref, number: pr.number, url: pr.url, headSha: pr.head.sha },
    });
    // One key per PR. An earlier item for it that was cancelled, failed or rejected gives the key
    // up to the new one.
    ctx.write(
      ctx.db
        .insertInto("core_intake_keys")
        .values({ dedupe_key: dedupeKey, work_item_id: created.id, created_at: ctx.now })
        .onConflict((oc) => oc.column("dedupe_key").doUpdateSet({ work_item_id: created.id })),
    );
    ctx.write(
      ctx.db.insertInto("core_intake_events").values({
        event_id: `attach:${crypto.randomUUID()}`,
        dedupe_key: dedupeKey,
        source: "pr",
        title,
        body: pr.body.slice(0, 50_000),
        actor_id: ctx.actor.id,
        received_at: ctx.now,
        work_item_id: created.id,
        outcome: "created",
      }),
    );
    // The PR's head no longer reads "Not attached": the factory is verifying it now.
    await postVerify(ctx, {
      project,
      repo,
      headSha: pr.head.sha,
      item: { id: created.id, pr_number: pr.number },
      prNumber: pr.number,
      packetId: null,
      output: {
        status: "in_progress",
        title: "The factory is verifying this commit",
        summary: `Attached to work item #${project.next_number}: ${title}\n\nVerify hasn't finished on this commit yet.`,
      },
    });
    return {
      workItemId: created.id,
      number: project.next_number,
      branch: created.branch,
      outcome: "created" as const,
    };
  },
});

export const workItemPreviewAttach = defineOperation({
  name: "workItem.previewAttach",
  description:
    "What attaching a pull request would do, for the app's `/attach` page (spec 05): the project the repo maps to, the PR (title, author, branch, head), why it can't be attached if it can't, and the work item it is already attached to. Reads GitHub; changes nothing.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ repo: repoName, prNumber: z.number().int().positive() }),
  output: z.object({
    project: z.object({ id: z.string(), name: z.string(), repo: z.string() }),
    pr: pullView.extend({ body: z.string() }),
    attachedWorkItemId: z.string().nullable(),
  }),
  scope: async (input, db) => repositoryForRepo(db, input.repo),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    const existing = await attachedItem(ctx, repository, input.prNumber);
    const { pr } = await readPull(ctx, repository, input.prNumber);
    const live = existing && (LIVE as readonly string[]).includes(existing.status);
    return {
      project: {
        id: project.id,
        name: project.name,
        repo: `${repository.owner}/${repository.name}`,
      },
      pr: view(repository, pr),
      attachedWorkItemId: live ? existing.id : null,
    };
  },
});

export const githubOpenPullRequests = defineOperation({
  name: "github.openPullRequests",
  description:
    "The project's open pull requests that no work item owns yet: not a factory branch, not already attached (spec 05). Each says why it can't be attached (a fork, not into the default branch), or null when New work can offer Attach.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId, repositoryId: repositoryId.optional() }),
  output: z.object({ pulls: z.array(pullView) }),
  async handler(_input, ctx) {
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const open = (await ctx.services.github.listOpenPullRequests(repo)).filter(
      (pr) => !pr.head.ref.startsWith("factory/"),
    );
    if (!open.length) return { pulls: [] };
    const owned = new Set(
      (
        await ctx.db
          .selectFrom("core_work_items")
          .select("pr_number")
          .where("repository_id", "=", repository.id)
          .where(
            "pr_number",
            "in",
            open.map((p) => p.number),
          )
          .where("status", "in", [...LIVE])
          .execute()
      ).map((r) => r.pr_number),
    );
    return {
      pulls: open
        .filter((pr) => !owned.has(pr.number))
        .map((pr) => {
          const { body: _body, ...rest } = view(repository, pr);
          return rest;
        }),
    };
  },
});

export const workItemAwaitHead = defineOperation({
  name: "workItem.awaitHead",
  description:
    "The attached-PR Workflow waits for a new push (spec 05): verify found problems, or the merge gate sent it back. If the PR's head has already moved past `headSha`, says so and nothing waits; otherwise the item waits with the reason, until `verify.refresh` records a new head and sends `pr-head-<item>`.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, headSha: sha, reason: z.string().max(4_000) }),
  output: z.object({ moved: z.boolean(), headSha: z.string().nullable(), event: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (w.kind !== "attached") {
      throw new OperationError("invalid_input", "only an attached PR's item waits for a push");
    }
    const event = prHeadEvent(w.id);
    if (w.head_sha !== input.headSha) return { moved: true, headSha: w.head_sha, event };
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ status: "waiting", status_reason: input.reason, updated_at: ctx.now })
        .where("id", "=", w.id)
        .where("status", "in", ["running", "waiting"]),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: "waiting", reason: input.reason, headSha: input.headSha },
    });
    return { moved: false, headSha: w.head_sha, event };
  },
});
