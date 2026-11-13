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

/** Tries at GitHub before the revert is given up and a person told. */
const MAX_ATTEMPTS = 3;
/** A caller's hold on asking GitHub; doubled per try, so one that keeps dying backs off. */
const LEASE_MS = 2 * 60_000;

/**
 * Whether GitHub's revert PR is the exact inverse of the culprit's merge (review of #178): the PR's
 * whole diff against its base on the default branch touches exactly the paths the merge changed;
 * at that base each of them still had the merge's content, and the PR's head puts back what the
 * merge's first parent had. revertVerdict's "the engine's unchanged revert" is this, never input.
 */
export async function exactInverse(
  ctx: HandlerContext,
  repo: RepoRef,
  defaultBranch: string,
  mergeSha: string,
  revertHead: string,
): Promise<boolean> {
  const github = ctx.services.github;
  const [before] = await github.commitParents(repo, mergeSha);
  if (!before) return false;
  const [culprit, pr] = await Promise.all([
    github.compareFiles(repo, before, mergeSha),
    github.changedPaths(repo, defaultBranch, revertHead),
  ]);
  // A rename's old path too: the inverse must put it back (review of #178).
  const paths = [
    ...new Set(culprit.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]))),
  ].sort();
  if (!pr.complete || !pr.mergeBase || paths.length === 0 || culprit.length >= 300) return false;
  if (pr.paths.length !== paths.length || pr.paths.some((p) => !paths.includes(p))) return false;
  const [atBefore, atMerge, atBase, atRevert] = await Promise.all([
    github.pathEntries(repo, before, paths),
    github.pathEntries(repo, mergeSha, paths),
    github.pathEntries(repo, pr.mergeBase, paths),
    github.pathEntries(repo, revertHead, paths),
  ]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return paths.every((p) => same(atBase[p], atMerge[p]) && same(atRevert[p], atBefore[p]));
}

export const mainRedRevert = defineOperation({
  name: "mainRed.revert",
  description:
    "Revert the landing that turned a repository's default branch red (spec 53 §5, decision 2). Only for the open episode's culprit as proven (the red reproduced) or named by a person: never a guess, an agent's naming, or (for the babysitter) a revert itself. In three calls, each committed before the next: the first claims the revert for this culprit and episode (`claimed`); the next takes the lease to ask GitHub (`calling`, with its `attempt`); the one carrying that attempt asks GitHub to revert the merge commit (no code written), or finds the revert PR GitHub already opened from this repository, as the App, into the default branch, and adds it as an attached repair with a person's merge gate (`opened`), telling the episode's audience. A GitHub refusal, or three tries that died, is recorded once (`failed`), with an incident, and not tried again for the episode. The babysitter acts once the episode is 30 minutes old with no other repair open; a person at any time.",
  risk: "write",
  actors: ["human", "agent"],
  permission: "approver",
  input: z.object({
    workItemId,
    /** The try this caller holds the lease for (from the `calling` answer). */
    attempt: z.number().int().min(1).optional(),
  }),
  output: z.object({
    status: z.enum(["claimed", "calling", "opened", "failed"]),
    attempt: z.number().nullable(),
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
    if (claim && claim.status !== "claimed" && claim.status !== "calling") {
      throw new OperationError("conflict", `#${w.number}'s revert is ${claim.status}`);
    }
    // The babysitter acts only while nobody else is on it: checked at every step, not only the
    // claim (review of #178). core_work_items_repair_idx: an open repair means someone is.
    if (by === "agent") {
      if (Date.parse(ctx.now) - Date.parse(health.red_since) < REVERT_AFTER_MS) {
        throw new OperationError("conflict", "main hasn't been red for 30 minutes");
      }
      const repair = await ctx.db
        .selectFrom("core_work_items")
        .select("id")
        .where("repository_id", "=", repository.id)
        .where("repairs_main", "=", 1)
        .where("status", "in", [...OPEN])
        .where("id", "!=", claim?.revert_work_item_id ?? "")
        .executeTakeFirst();
      if (repair) throw new OperationError("conflict", "a repair is already under way");
    }
    if (!claim) {
      // The chain's root: a culprit that is itself a reland carries its original's root.
      const relandOf = await ctx.db
        .selectFrom("core_reverts")
        .select("root_work_item_id")
        .where("reland_work_item_id", "=", w.id)
        .executeTakeFirst();
      // Committed before GitHub is asked; the unique index refuses a second claim.
      ctx.write(
        ctx.db.insertInto("core_reverts").values({
          id: newId("revert"),
          original_work_item_id: w.id,
          repository_id: repository.id,
          project_id: project.id,
          red_since: health.red_since,
          status: "claimed",
          attempts: 0,
          lease_until: null,
          revert_branch: null,
          root_work_item_id: relandOf?.root_work_item_id ?? w.id,
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
      return { status: "claimed" as const, attempt: null, revertWorkItemId: null, prNumber: null };
    }

    // The lease to ask GitHub: one caller at a time, taken over only once it has expired.
    if (_input.attempt === undefined) {
      if (claim.status === "calling" && claim.lease_until && claim.lease_until > ctx.now) {
        throw new OperationError("conflict", `#${w.number}'s revert is being asked of GitHub`);
      }
      if (claim.attempts >= MAX_ATTEMPTS) {
        // A try that died after GitHub answered may have left the revert PR open: close it, so
        // nothing stays open that no item tracks (review of #178).
        const repo = await repoRef(ctx, repository);
        const left = await findRevertPr(
          ctx,
          repo,
          repository.default_branch,
          w.pr_number,
          claim.revert_branch,
        );
        if (left)
          await ctx.services.github.closePullRequest(repo, left.number).catch(() => undefined);
        return giveUp(
          ctx,
          w,
          claim.id,
          health.audience,
          repository.default_branch,
          `${MAX_ATTEMPTS} tries at GitHub didn't finish`,
        );
      }
      const attempt = claim.attempts + 1;
      ctx.write(
        ctx.db
          .updateTable("core_reverts")
          .set({
            status: "calling",
            attempts: attempt,
            lease_until: new Date(
              Date.parse(ctx.now) + LEASE_MS * 2 ** (attempt - 1),
            ).toISOString(),
            updated_at: ctx.now,
          })
          .where("id", "=", claim.id)
          .where("attempts", "=", claim.attempts),
      );
      ctx.guardChanged("no other caller took the lease");
      return { status: "calling" as const, attempt, revertWorkItemId: null, prNumber: null };
    }
    if (claim.status !== "calling" || claim.attempts !== _input.attempt) {
      throw new OperationError("conflict", `#${w.number}'s revert lease is another caller's`);
    }

    if (!ctx.scope.policy) {
      throw new OperationError("unavailable", `project ${project.name} has no valid config`);
    }
    const repo = await repoRef(ctx, repository);
    const github = ctx.services.github;
    // Asked before and not recorded (a call that died after GitHub's answer): GitHub's own revert
    // PR, from this repository (never a fork), by the App, into the default branch, on the branch
    // GitHub named when that is known; take it rather than open a second one.
    const prior = await findRevertPr(
      ctx,
      repo,
      repository.default_branch,
      w.pr_number,
      claim.revert_branch,
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
      // The lease again, just before GitHub is asked (review of #178): a caller that took it over
      // meanwhile refuses this one.
      const still = await ctx.db
        .selectFrom("core_reverts")
        .select(["status", "attempts", "lease_until"])
        .where("id", "=", claim.id)
        .executeTakeFirst();
      if (
        still?.status !== "calling" ||
        still.attempts !== _input.attempt ||
        (still.lease_until ?? "") <= ctx.now
      ) {
        throw new OperationError(
          "conflict",
          `#${w.number}'s revert lease is no longer this call's`,
        );
      }
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
        return giveUp(
          ctx,
          w,
          claim.id,
          health.audience,
          repository.default_branch,
          `GitHub couldn't revert: ${why}`,
        );
      }
    }
    if (!prior) {
      // GitHub's answer is committed on its own (review of #178): the branch and PR are recorded
      // before anything else, so a call that dies after this finds that PR by its exact branch.
      ctx.write(
        ctx.db
          .updateTable("core_reverts")
          .set({ revert_branch: made.branch, revert_pr_number: made.number, updated_at: ctx.now })
          .where("id", "=", claim.id)
          .where("status", "=", "calling")
          .where("attempts", "=", _input.attempt),
      );
      ctx.guardChanged("this caller still holds the lease");
      return {
        status: "calling" as const,
        attempt: _input.attempt,
        revertWorkItemId: null,
        prNumber: made.number,
      };
    }
    const exact = await exactInverse(
      ctx,
      repo,
      repository.default_branch,
      w.merge_sha,
      made.headSha,
    ).catch(() => false);
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
          revert_branch: made.branch,
          exact_inverse: exact ? 1 : 0,
          lease_until: null,
          updated_at: ctx.now,
        })
        .where("id", "=", claim.id)
        .where("status", "=", "calling")
        .where("attempts", "=", _input.attempt),
    );
    ctx.guardChanged("this caller still holds the lease");
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
    return {
      status: "opened" as const,
      attempt: _input.attempt,
      revertWorkItemId: created.id,
      prNumber: made.number,
    };
  },
});

/**
 * GitHub's own revert PR for `prNumber`: from this repository (never a fork), by the App, into the
 * default branch, on `branch` when GitHub's answer recorded it, else on `revert-<pr>-…`.
 */
async function findRevertPr(
  ctx: HandlerContext,
  repo: RepoRef,
  defaultBranch: string,
  prNumber: number,
  branch: string | null,
) {
  const github = ctx.services.github;
  const own = `${repo.owner}/${repo.repo}`.toLowerCase();
  return (await github.listOpenPullRequests(repo)).find(
    (p) =>
      p.head.repo?.toLowerCase() === own &&
      p.author === `${github.app.slug}[bot]` &&
      p.base.ref === defaultBranch &&
      (branch ? p.head.ref === branch : p.head.ref.startsWith(`revert-${prNumber}-`)),
  );
}

/** Not tried again for this episode: recorded once, an incident opened, the owner told. */
async function giveUp(
  ctx: HandlerContext,
  w: WorkItemRow,
  claimId: string,
  audience: string,
  branch: string,
  why: string,
) {
  ctx.write(
    ctx.db
      .updateTable("core_reverts")
      .set({ status: "failed", reason: why, lease_until: null, updated_at: ctx.now })
      .where("id", "=", claimId)
      .where("status", "in", ["claimed", "calling"]),
  );
  await openIncident(ctx, {
    kind: "manual",
    reason: `The factory couldn't revert #${w.number} after it turned ${branch} red: ${why}`,
    runId: null,
  });
  tell(ctx, audience, {
    event: "main.revert",
    workItemId: w.id,
    title: `The factory couldn't revert #${w.number}: ${branch} stays red until a person repairs it.`,
  });
  return { status: "failed" as const, attempt: null, revertWorkItemId: null, prNumber: null };
}

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
        "core_reverts.root_work_item_id",
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
      // core_reverts_root_idx: relands anywhere in this chain (a reland's reland counts too).
      ctx.db
        .selectFrom("core_reverts")
        .select("id")
        .where("root_work_item_id", "=", row.root_work_item_id)
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

export const mainRedCloseRevert = defineOperation({
  name: "mainRed.closeRevert",
  description:
    "A factory revert whose work item ended without merging (cancelled, failed or rejected): its PR on GitHub is closed and the revert is marked abandoned, so nothing reads it again (spec 53 §5). The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({ closed: z.boolean() }),
  async handler(_input, ctx) {
    if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) {
      throw new OperationError("forbidden", "only the babysitter closes a revert");
    }
    const revert = requireWorkItem(ctx);
    if (!["cancelled", "failed", "rejected"].includes(revert.status)) {
      throw new OperationError("conflict", `the revert #${revert.number} hasn't ended unmerged`);
    }
    // core_reverts_revert_idx.
    const row = await ctx.db
      .selectFrom("core_reverts")
      .select(["id", "status", "revert_pr_number"])
      .where("revert_work_item_id", "=", revert.id)
      .executeTakeFirst();
    if (row?.status !== "opened") return { closed: false };
    if (row.revert_pr_number) {
      const repo = await repoRef(ctx, requireRepository(ctx));
      await ctx.services.github.closePullRequest(repo, row.revert_pr_number);
    }
    ctx.write(
      ctx.db
        .updateTable("core_reverts")
        .set({
          status: "abandoned",
          reason: `the revert ended ${revert.status}`,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id)
        .where("status", "=", "opened"),
    );
    ctx.change({ entity: "work_item", id: revert.id, after: { revertAbandoned: true } });
    return { closed: true };
  },
});

function tellRequester(ctx: HandlerContext, userId: string, workItemId: string, title: string) {
  ctx.emit({
    kind: "notify",
    payload: { event: "main.reland", userId, workItemId, title, url: `/work/${workItemId}` },
  });
}

export type { WorkItemRow };
