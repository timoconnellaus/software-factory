// The engine-made revert of a red main's culprit, and its reland (spec 53 §5, decisions 2 and 5,
// ADRs 0584 and 0622). Only a culprit that was proven (it reproduced) or named by a person is ever
// reverted: never a guess, and never one an agent named. GitHub makes the revert (the inverse of the
// culprit's merge commit; no code is written here); it lands as an attached PR marked as a repair,
// through verify and its own merge gate. A person decides that gate unless the workflow's
// `revertWithoutPerson` is on and `revertVerdict()` holds (wired with ADR 0515's auto-approve
// actor). Once the revert has merged, the reverted item stays Done and a "Reland: <title>" backlog
// item is linked to it, with a comment on the original PR.
import { z } from "zod";
import { BABYSITTER } from "../actors.ts";
import { REVERT_AFTER_MS } from "../babysit/revert.ts";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { startPipeline } from "./backlog.ts";
import {
  createWorkItem,
  repoRef,
  requireProject,
  requireRepository,
  requireWorkItem,
  workItemId,
} from "./shared.ts";

const OPEN = ["running", "waiting", "paused", "queued", "ready", "backlog", "shaping"] as const;

function babysitterOrPerson(ctx: HandlerContext): "agent" | "person" {
  if (ctx.actor.type === "human") return "person";
  if (ctx.actor.type === BABYSITTER.type && ctx.actor.id === BABYSITTER.id) return "agent";
  throw new OperationError("forbidden", "only a person or the babysitter reverts a culprit");
}

export const mainRedRevert = defineOperation({
  name: "mainRed.revert",
  description:
    "Revert the landing that turned a repository's default branch red (spec 53 §5, decision 2): GitHub reverts its merge commit and opens a PR with exactly the inverse change, which joins the factory as an attached repair (verify, then its own merge gate). Only for the open episode's culprit as proven (the red reproduced) or named by a person, never a guess or an agent's naming. The babysitter makes it once the episode is 30 minutes old with no other repair open; a person may ask at any time. One revert per culprit. A person is told when the revert's merge needs them.",
  risk: "write",
  actors: ["human", "agent"],
  permission: "approver",
  input: z.object({ workItemId }),
  output: z.object({ revertWorkItemId: z.string(), prNumber: z.number() }),
  async handler(_input, ctx) {
    const by = babysitterOrPerson(ctx);
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    if (!w.pr_number || !w.merge_sha || w.status !== "done") {
      throw new OperationError(
        "conflict",
        `#${w.number} hasn't landed: there is nothing to revert`,
      );
    }
    const health = await ctx.db
      .selectFrom("core_main_health")
      .select(["red_since", "culprit_work_item_id", "attributed_by", "audience"])
      .where("repository_id", "=", repository.id)
      .executeTakeFirst();
    if (!health?.red_since) throw new OperationError("conflict", "the default branch isn't red");
    if (
      health.culprit_work_item_id !== w.id ||
      (health.attributed_by !== "proven" && health.attributed_by !== "person")
    ) {
      throw new OperationError(
        "conflict",
        `#${w.number} isn't this episode's proven or person-named culprit: a revert is never of a guess`,
      );
    }
    // core_reverts_original_idx: one revert per culprit.
    const before = await ctx.db
      .selectFrom("core_reverts")
      .select("revert_work_item_id")
      .where("original_work_item_id", "=", w.id)
      .executeTakeFirst();
    if (before) throw new OperationError("conflict", `#${w.number} was already reverted`);
    if (by === "agent") {
      if (Date.parse(ctx.now) - Date.parse(health.red_since) < REVERT_AFTER_MS) {
        throw new OperationError("conflict", "main hasn't been red for 30 minutes");
      }
      // core_work_items_repair_idx: an open repair means someone is on it.
      const repair = await ctx.db
        .selectFrom("core_work_items")
        .select("id")
        .where("repository_id", "=", repository.id)
        .where("repairs_main", "=", 1)
        .where("status", "in", [...OPEN])
        .executeTakeFirst();
      if (repair) throw new OperationError("conflict", "a repair is already under way");
    }
    if (!ctx.scope.policy) {
      throw new OperationError("unavailable", `project ${project.name} has no valid config`);
    }
    const repo = await repoRef(ctx, repository);
    const title = `Revert "${w.title}"`.slice(0, 200);
    const made = await ctx.services.github.revertPullRequest(repo, {
      number: w.pr_number,
      title,
      body: `The factory reverts #${w.pr_number} (work item #${w.number}): ${repository.default_branch} went red on its merge ${w.merge_sha.slice(0, 7)}. This PR is GitHub's exact inverse of that merge; no code was written. When it lands, "Reland: ${w.title}" is added to the backlog.`,
    });
    const created = createWorkItem(ctx, {
      project,
      repositoryId: repository.id,
      title,
      body: `Reverts work item #${w.number} (PR #${w.pr_number}), which turned ${repository.default_branch} red. Made by ${by === "person" ? "a person's request" : "the babysitter"}.`,
      source: "babysitter",
      kind: "attached",
      requesterUserId: by === "person" ? ctx.actor.id : w.requester_user_id,
      number: project.next_number,
      pr: { branch: made.branch, number: made.number, url: made.url, headSha: made.headSha },
      state: "queued",
    });
    startPipeline(ctx, created, project, {
      policy: ctx.scope.policy,
      trial: null,
      workflow: false,
    });
    // A repair: it lands while the line is stopped, ahead of held work.
    ctx.write(
      ctx.db.updateTable("core_work_items").set({ repairs_main: 1 }).where("id", "=", created.id),
    );
    ctx.write(
      ctx.db.insertInto("core_reverts").values({
        revert_work_item_id: created.id,
        original_work_item_id: w.id,
        repository_id: repository.id,
        project_id: project.id,
        red_since: health.red_since,
        reland_work_item_id: null,
        created_at: ctx.now,
      }),
    );
    // Decision 4: a phone push when a revert needs a person (its merge gate is theirs until the
    // auto-approve actor may decide it under `revertVerdict()`).
    let audience: string[] = [];
    try {
      audience = JSON.parse(health.audience) as string[];
    } catch {
      audience = [];
    }
    for (const userId of audience) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "main.revert",
          userId,
          workItemId: created.id,
          title: `A revert of #${w.number} "${w.title}" needs you: ${repository.default_branch} is red on it.`,
          url: `/work/${created.id}`,
        },
      });
    }
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { revertedBy: created.id, revertPr: made.number, by },
    });
    return { revertWorkItemId: created.id, prNumber: made.number };
  },
});

export const mainRedReland = defineOperation({
  name: "mainRed.reland",
  description:
    'Once the factory\'s revert of a culprit has merged (spec 53 decision 5): the reverted item stays Done, and a new backlog item "Reland: <title>" is linked to it (not released), with a comment on the original PR saying what was reverted and why. Once per revert. The babysitter only.',
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ relandWorkItemId: z.string() }),
  async handler(_input, ctx) {
    if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) {
      throw new OperationError("forbidden", "only the babysitter relands");
    }
    const revert = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const row = await ctx.db
      .selectFrom("core_reverts")
      .innerJoin("core_work_items as o", "o.id", "core_reverts.original_work_item_id")
      .select([
        "core_reverts.reland_work_item_id",
        "o.id",
        "o.number",
        "o.title",
        "o.body",
        "o.pr_number",
        "o.requester_user_id",
        "o.repository_id",
      ])
      .where("core_reverts.revert_work_item_id", "=", revert.id)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", `#${revert.number} is not a revert`);
    if (row.reland_work_item_id) {
      throw new OperationError("conflict", `#${row.number} already has its reland item`);
    }
    if (revert.status !== "done") {
      throw new OperationError("conflict", `the revert #${revert.number} hasn't merged`);
    }
    const created = createWorkItem(ctx, {
      project,
      repositoryId: row.repository_id,
      title: `Reland: ${row.title}`.slice(0, 200),
      body: [
        `Work item #${row.number} turned the default branch red and was reverted by #${revert.number}. It stays Done; this item lands it again, fixed.`,
        "",
        "The original request:",
        "",
        row.body,
      ].join("\n"),
      source: "babysitter",
      requesterUserId: row.requester_user_id,
      parentWorkItemId: row.id,
      number: project.next_number,
      state: "backlog",
    });
    ctx.write(
      ctx.db
        .updateTable("core_reverts")
        .set({ reland_work_item_id: created.id })
        .where("revert_work_item_id", "=", revert.id)
        .where("reland_work_item_id", "is", null),
    );
    ctx.guardChanged("not relanded yet");
    if (row.pr_number) {
      const repo = await repoRef(ctx, requireRepository(ctx));
      await ctx.services.github
        .commentOnPullRequest(
          repo,
          row.pr_number,
          `The factory reverted this change (#${revert.pr_number ?? revert.number}) because the default branch went red on its merge. "Reland: ${row.title}" is in the backlog to land it again, fixed.`,
        )
        .catch(() => undefined);
    }
    ctx.change({
      entity: "work_item",
      id: row.id,
      after: { relandWorkItemId: created.id, revertedBy: revert.id },
    });
    return { relandWorkItemId: created.id };
  },
});
