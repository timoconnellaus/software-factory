// The engine-made revert of a red main's culprit, and its reland (spec 53 §5, decisions 2 and 5,
// ADRs 0584 and 0622). Only a culprit that was proven (it reproduced) or named by a person is ever
// reverted: never a guess, and never one an agent named. GitHub makes the revert (the inverse of the
// culprit's merge commit; no code is written here); it lands as an attached PR marked as a repair,
// through verify and a person's merge gate. Once it has merged, the reverted item stays Done and a
// "Reland: <title>" backlog item is linked to it, with a comment on the original PR.
//
// The revert is claimed before GitHub is asked (review of #178): `mainRed.revert`'s first call
// commits a claim, unique per culprit and episode; its next call asks GitHub, or, when a claim was
// asked and not recorded, finds the revert PR GitHub already opened instead of opening another.
import { z } from "zod";
import { BABYSITTER } from "../actors.ts";
import { REVERT_AFTER_MS } from "../babysit/revert.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext, type WorkItemRow } from "../operation.ts";
import type { RepoRef } from "../services.ts";
import { attachKey } from "./attach.ts";
import { startPipeline } from "./backlog.ts";
import { openIncident } from "./incidents.ts";
import {
  createWorkItem,
  repoRef,
  requireProject,
  requireRepository,
  requireWorkItem,
  workItemId,
} from "./shared.ts";
import { cleanTitle } from "./summary.ts";

const OPEN = ["running", "waiting", "paused", "queued", "ready", "backlog", "shaping"] as const;
/** Most relands of one original: past it, the owner decides (review of #178). */
const MAX_RELANDS = 1;

/**
 * Text the App posts on GitHub, made inert (review of #178): a title in code formatting can't
 * mention anyone, link anywhere or close an issue ("Fixes #1"), whatever it says.
 */
export const inert = (text: string) => `\`${cleanTitle(text).replace(/`/g, "'")}\``;
/** A PR title the App sets: one line, no mention that GitHub would expand. */
const plainTitle = (text: string) => cleanTitle(text).replace(/@/g, "@⁠");

function babysitterOrPerson(ctx: HandlerContext): "agent" | "person" {
  if (ctx.actor.type === "human") return "person";
  if (ctx.actor.type === BABYSITTER.type && ctx.actor.id === BABYSITTER.id) return "agent";
  throw new OperationError("forbidden", "only a person or the babysitter reverts a culprit");
}

/**
 * Whether GitHub's revert PR is the exact inverse of the culprit's merge (review of #178): on every
 * path the merge changed, the revert's head has what the merge's first parent had, and the revert
 * changes nothing else. revertVerdict's "the engine's unchanged revert" is this, never the input.
 */
export async function exactInverse(
  ctx: HandlerContext,
  repo: RepoRef,
  mergeSha: string,
  revertHead: string,
): Promise<boolean> {
  const github = ctx.services.github;
  const [[before], [revertBase]] = await Promise.all([
    github.commitParents(repo, mergeSha),
    github.commitParents(repo, revertHead),
  ]);
  if (!before || !revertBase) return false;
  const [culprit, revert] = await Promise.all([
    github.compareFiles(repo, before, mergeSha),
    github.compareFiles(repo, revertBase, revertHead),
  ]);
  const paths = culprit.map((f) => f.path);
  if (paths.length === 0 || paths.length >= 300 || revert.length >= 300) return false;
  if (revert.some((f) => !paths.includes(f.path))) return false;
  const [atBefore, atRevert] = await Promise.all([
    github.pathEntries(repo, before, paths),
    github.pathEntries(repo, revertHead, paths),
  ]);
  return paths.every(
    (p) => JSON.stringify(atBefore[p] ?? null) === JSON.stringify(atRevert[p] ?? null),
  );
}

export const mainRedRevert = defineOperation({
  name: "mainRed.revert",
  description:
    "Revert the landing that turned a repository's default branch red (spec 53 §5, decision 2). Only for the open episode's culprit as proven (the red reproduced) or named by a person: never a guess, an agent's naming, or (for the babysitter) a revert itself. In two calls: the first claims the revert for this culprit and episode (`claimed`); the next asks GitHub to revert its merge commit (the exact inverse, no code written), or finds the revert PR GitHub already opened, and adds it as an attached repair with a person's merge gate (`opened`), telling the episode's audience. A GitHub refusal is recorded once (`failed`), with an incident, and not tried again for the episode. The babysitter acts once the episode is 30 minutes old with no other repair open; a person at any time.",
  risk: "write",
  actors: ["human", "agent"],
  permission: "approver",
  input: z.object({ workItemId }),
  output: z.object({
    status: z.enum(["claimed", "opened", "failed"]),
    revertWorkItemId: z.string().nullable(),
    prNumber: z.number().nullable(),
  }),
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
    // A merged revert is never reverted by the babysitter (review of #178): a person decides.
    const isRevert = await ctx.db
      .selectFrom("core_reverts")
      .select("id")
      .where("revert_work_item_id", "=", w.id)
      .executeTakeFirst();
    if (isRevert && by === "agent") {
      throw new OperationError("conflict", `#${w.number} is itself a revert: a person decides`);
    }
    // core_reverts_claim_idx: this culprit's claim in this episode.
    const claim = await ctx.db
      .selectFrom("core_reverts")
      .selectAll()
      .where("original_work_item_id", "=", w.id)
      .where("red_since", "=", health.red_since)
      .executeTakeFirst();
    if (claim && claim.status !== "claimed") {
      throw new OperationError("conflict", `#${w.number}'s revert is ${claim.status}`);
    }
    if (!claim) {
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
      // Committed before GitHub is asked; the unique index refuses a second claim.
      ctx.write(
        ctx.db.insertInto("core_reverts").values({
          id: newId("revert"),
          original_work_item_id: w.id,
          repository_id: repository.id,
          project_id: project.id,
          red_since: health.red_since,
          status: "claimed",
          revert_pr_number: null,
          revert_work_item_id: null,
          exact_inverse: null,
          reason: null,
          reland_work_item_id: null,
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
      ctx.change({ entity: "work_item", id: w.id, after: { revertClaimed: true, by } });
      return { status: "claimed" as const, revertWorkItemId: null, prNumber: null };
    }

    if (!ctx.scope.policy) {
      throw new OperationError("unavailable", `project ${project.name} has no valid config`);
    }
    const repo = await repoRef(ctx, repository);
    const github = ctx.services.github;
    // Asked before and not recorded (a commit that failed after GitHub's answer): GitHub's revert
    // branch is `revert-<pr>-<head branch>`; take that PR rather than open a second one.
    const prior = (await github.listOpenPullRequests(repo)).find((p) =>
      p.head.ref.startsWith(`revert-${w.pr_number}-`),
    );
    let made: { number: number; branch: string; headSha: string; url: string };
    if (prior) {
      made = {
        number: prior.number,
        branch: prior.head.ref,
        headSha: prior.head.sha,
        url: prior.url,
      };
    } else {
      try {
        made = await github.revertPullRequest(repo, {
          number: w.pr_number,
          title: plainTitle(`Revert “${cleanTitle(w.title)}”`).slice(0, 200),
          body: [
            `The factory reverts #${w.pr_number} (work item #${w.number}, ${inert(w.title)}): ${repository.default_branch} went red on its merge ${w.merge_sha.slice(0, 7)}.`,
            "This PR is GitHub's own inverse of that merge; no code was written. Once it lands, a reland item is added to the backlog.",
          ].join("\n\n"),
        });
      } catch (error) {
        const why = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        // Not tried again for this episode: recorded, an incident opened, the owner told.
        ctx.write(
          ctx.db
            .updateTable("core_reverts")
            .set({
              status: "failed",
              reason: `GitHub couldn't revert: ${why}`,
              updated_at: ctx.now,
            })
            .where("id", "=", claim.id)
            .where("status", "=", "claimed"),
        );
        await openIncident(ctx, {
          kind: "manual",
          reason: `The factory couldn't revert #${w.number} after it turned ${repository.default_branch} red: ${why}`,
          runId: null,
        });
        tell(ctx, health.audience, {
          event: "main.revert",
          workItemId: w.id,
          title: `The factory couldn't revert #${w.number}: ${repository.default_branch} stays red until a person repairs it.`,
        });
        return { status: "failed" as const, revertWorkItemId: null, prNumber: null };
      }
    }
    const exact = await exactInverse(ctx, repo, w.merge_sha, made.headSha).catch(() => false);
    const title = plainTitle(`Revert “${cleanTitle(w.title)}”`).slice(0, 200);
    const created = createWorkItem(ctx, {
      project,
      repositoryId: repository.id,
      title,
      body: `Reverts work item #${w.number} (PR #${w.pr_number}), which turned ${repository.default_branch} red. Claimed by ${by === "person" ? "a person" : "the babysitter"}. ${exact ? "GitHub's revert is the exact inverse of its merge." : "Not the exact inverse of its merge (main changed those files since): review it in full."}`,
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
    // The PR's intake key, as workItem.attachPr writes: attaching it again finds this item.
    ctx.write(
      ctx.db
        .insertInto("core_intake_keys")
        .values({
          dedupe_key: attachKey(repository, made.number),
          work_item_id: created.id,
          created_at: ctx.now,
        })
        .onConflict((oc) => oc.column("dedupe_key").doUpdateSet({ work_item_id: created.id })),
    );
    ctx.write(
      ctx.db
        .updateTable("core_reverts")
        .set({
          status: "opened",
          revert_pr_number: made.number,
          revert_work_item_id: created.id,
          exact_inverse: exact ? 1 : 0,
          updated_at: ctx.now,
        })
        .where("id", "=", claim.id)
        .where("status", "=", "claimed"),
    );
    ctx.guardChanged("the revert is still claimed");
    // Decision 4: a phone push when a revert needs a person (its merge gate is theirs).
    tell(ctx, health.audience, {
      event: "main.revert",
      workItemId: created.id,
      title: `A revert of #${w.number} needs you: ${repository.default_branch} is red on it.`,
    });
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { revertedBy: created.id, revertPr: made.number, exactInverse: exact, by },
    });
    return { status: "opened" as const, revertWorkItemId: created.id, prNumber: made.number };
  },
});

function tell(
  ctx: HandlerContext,
  audience: string,
  n: { event: string; workItemId: string; title: string },
) {
  let users: string[] = [];
  try {
    users = JSON.parse(audience) as string[];
  } catch {
    users = [];
  }
  for (const userId of users) {
    ctx.emit({
      kind: "notify",
      payload: { ...n, userId, url: `/work/${n.workItemId}` },
    });
  }
}

export const mainRedReland = defineOperation({
  name: "mainRed.reland",
  description:
    'Once the factory\'s revert of a culprit has merged (spec 53 decision 5): the reverted item stays Done, and a new backlog item "Reland: <title>" is linked to it (not released), with a comment on the original PR (posted after this commits) saying what was reverted. Never for an original that is itself a revert, and at most one reland per original: past it, the owner is told instead. Once per revert. The babysitter only.',
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ relandWorkItemId: z.string().nullable(), reason: z.string().nullable() }),
  async handler(_input, ctx) {
    if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) {
      throw new OperationError("forbidden", "only the babysitter relands");
    }
    const revert = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const repository = requireRepository(ctx);
    const row = await ctx.db
      .selectFrom("core_reverts")
      .innerJoin("core_work_items as o", "o.id", "core_reverts.original_work_item_id")
      .select([
        "core_reverts.id as revert_id",
        "core_reverts.status",
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
    if (row.status !== "opened") {
      throw new OperationError("conflict", `#${row.number}'s revert is ${row.status}`);
    }
    if (revert.status !== "done") {
      throw new OperationError("conflict", `the revert #${revert.number} hasn't merged`);
    }
    // No "Reland: Revert …": the original is itself a revert. And one reland per original.
    const [originalIsRevert, earlier] = await Promise.all([
      ctx.db
        .selectFrom("core_reverts")
        .select("id")
        .where("revert_work_item_id", "=", row.id)
        .executeTakeFirst(),
      ctx.db
        .selectFrom("core_reverts")
        .select("id")
        .where("original_work_item_id", "=", row.id)
        .where("reland_work_item_id", "is not", null)
        .limit(MAX_RELANDS)
        .execute(),
    ]);
    const skip = originalIsRevert
      ? `#${row.number} is itself a revert: no reland`
      : earlier.length >= MAX_RELANDS
        ? `#${row.number} was already relanded once and reverted again: the owner decides`
        : null;
    let relandId: string | null = null;
    if (!skip) {
      const created = createWorkItem(ctx, {
        project,
        repositoryId: row.repository_id,
        title: `Reland: ${cleanTitle(row.title)}`.slice(0, 200),
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
      relandId = created.id;
    } else {
      tellRequester(ctx, row.requester_user_id, row.id, skip);
    }
    ctx.write(
      ctx.db
        .updateTable("core_reverts")
        .set({
          status: "relanded",
          reland_work_item_id: relandId,
          reason: skip,
          updated_at: ctx.now,
        })
        .where("id", "=", row.revert_id)
        .where("status", "=", "opened"),
    );
    ctx.guardChanged("not relanded yet");
    // Posted once, after this commits (an outbox message), in inert text.
    if (row.pr_number) {
      const repo = await repoRef(ctx, repository);
      ctx.emit({
        kind: "github.comment",
        payload: {
          repo: { installationId: repo.installationId, owner: repo.owner, repo: repo.repo },
          number: row.pr_number,
          body: `The factory reverted this change (PR #${revert.pr_number ?? revert.number}) because the default branch went red on its merge.${relandId ? ` A reland item, ${inert(`Reland: ${row.title}`)}, is in the backlog.` : ""}`,
        },
      });
    }
    ctx.change({
      entity: "work_item",
      id: row.id,
      after: { relandWorkItemId: relandId, revertedBy: revert.id, skip },
    });
    return { relandWorkItemId: relandId, reason: skip };
  },
});

function tellRequester(ctx: HandlerContext, userId: string, workItemId: string, title: string) {
  ctx.emit({
    kind: "notify",
    payload: { event: "main.reland", userId, workItemId, title, url: `/work/${workItemId}` },
  });
}

export type { WorkItemRow };
