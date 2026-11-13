// The babysitter's `babysit` job (spec 53 §4 and §6, ADRs 0583 and 0585). The deliverer wakes one
// only when it meets something it can't decide in code: a head that conflicts with the default
// branch (a factory item; an attached PR's conflict goes back to its author, decision 8), or a
// required check that failed after the head was brought up to date. At most one job per
// repository is open; each new job raises the repository's **delivery fence**, and every write its
// result leads to carries the fence and is refused when it is stale (a dead job's late result).
//
// The job only judges, and for a conflict resolves it on its run branch. What follows is code, each
// step with its own floor: `ci.rerun` reruns a failed check once per SHA (a second time is refused),
// `flake.record` adds a rerun that passed to the known-flake list (and opens a backlog item once a
// check flakes three times in 14 days, decision 3), `branch.advance` moves the item's branch to a
// resolution (which withdraws the approval: the person sees only the resolution, decision 1), and
// `babysit.next` closes the job.
import { parseJson } from "@software-factory/db";
import { babysitResultSchema, stagePool } from "@software-factory/runner-contract";
import { z } from "zod";
import { BABYSITTER } from "../actors.ts";
import { babysitPrompt } from "../babysit/prompt.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext, type WorkItemRow } from "../operation.ts";
import {
  createWorkItem,
  repoRef,
  requireProject,
  requireRepository,
  requireWorkItem,
  sha,
  workItemId,
} from "./shared.ts";

/** A flake seen this many times in FLAKE_WINDOW_DAYS opens a backlog item to fix it (decision 3). */
export const FLAKE_FIX_AFTER = 3;
export const FLAKE_WINDOW_DAYS = 14;
/** How long a `babysit` job's session may run. */
const BABYSIT_TIMEOUT_MS = 30 * 60_000;
/** Conclusions that count as a failed check. */
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export const babysitReasonSchema = z.object({
  kind: z.enum(["conflict", "check-failed"]),
  workItemId,
  headSha: sha,
  /** For `check-failed`: the failing checks, as ci.read named them. */
  checks: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** Which try this is: a job that died is replaced once, with a note of what it left. */
  attempt: z.number().int().min(1).max(5).default(1),
});
export type BabysitReason = z.infer<typeof babysitReasonSchema>;

const deliveryFence = z.number().int().min(1);

/** The deliverer's key for a repository's queue (the same as apps/engine's `deliveryKey`). */
const keyOf = (w: Pick<WorkItemRow, "project_id" | "repository_id">) =>
  `${w.project_id}:${w.repository_id ?? ""}`;

function onlyBabysitter(ctx: HandlerContext): void {
  if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) {
    throw new OperationError("forbidden", "only the babysitter's deliverer does this");
  }
}

async function deliveryState(ctx: HandlerContext, w: WorkItemRow) {
  // core_delivery_state's primary key.
  const row = await ctx.db
    .selectFrom("core_delivery_state")
    .select(["key", "babysit_job_id", "babysit_fence", "babysit_reasons"])
    .where("key", "=", keyOf(w))
    .executeTakeFirst();
  if (!row) throw new OperationError("conflict", "the repository has no delivery queue");
  return row;
}

/** Refuses a write whose delivery fence is no longer the repository's (ADR 0585). */
async function requireFence(ctx: HandlerContext, w: WorkItemRow, fence: number) {
  const state = await deliveryState(ctx, w);
  if (state.babysit_fence !== fence) {
    throw new OperationError(
      "fenced",
      `stale delivery fence ${fence}: the repository's babysit job is ${state.babysit_fence}`,
    );
  }
  return state;
}

export const babysitWake = defineOperation({
  name: "babysit.wake",
  description:
    "The babysitter's deliverer met something it can't decide (spec 53 §4): a head that conflicts with the default branch, or a required check that failed after the head was brought up to date. Starts the repository's `babysit` job for it, raising the delivery fence, or, while one is open, queues the reason on it. A conflict on an attached PR is refused: it goes back to its author, and the factory never pushes to their branch (decision 8). The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, reason: babysitReasonSchema.omit({ workItemId: true }) }),
  output: z.object({ jobId: z.string(), deliveryFence: z.number(), started: z.boolean() }),
  async handler(input, ctx) {
    onlyBabysitter(ctx);
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    if (input.reason.kind === "conflict" && w.kind === "attached") {
      throw new OperationError(
        "forbidden",
        "an attached pull request's conflict goes back to its author: the factory never pushes to their branch",
      );
    }
    const reason: BabysitReason = { ...input.reason, workItemId: w.id };
    const state = await deliveryState(ctx, w);
    const reasons = parseJson<BabysitReason[]>(state.babysit_reasons, []);
    if (state.babysit_job_id) {
      const open = await ctx.db
        .selectFrom("core_jobs")
        .select("status")
        .where("id", "=", state.babysit_job_id)
        .executeTakeFirst();
      if (open && (open.status === "queued" || open.status === "claimed")) {
        const same = reasons.some(
          (r) => r.kind === reason.kind && r.workItemId === w.id && r.headSha === reason.headSha,
        );
        if (!same) {
          ctx.write(
            ctx.db
              .updateTable("core_delivery_state")
              .set({ babysit_reasons: JSON.stringify([...reasons, reason]) })
              .where("key", "=", state.key)
              .where("babysit_fence", "=", state.babysit_fence),
          );
        }
        return { jobId: state.babysit_job_id, deliveryFence: state.babysit_fence, started: false };
      }
    }

    const repo = await repoRef(ctx, repository);
    const failing: { name: string; url: string | null; detail: string }[] = [];
    if (reason.kind === "check-failed") {
      const runs = await ctx.services.github.listCheckRuns(repo, reason.headSha);
      for (const name of reason.checks.slice(0, 5)) {
        const run = runs.find((r) => r.name === name && FAILED.has(r.conclusion ?? ""));
        failing.push({
          name,
          url: run?.url ?? null,
          detail: run ? await ctx.services.github.checkRunDetail(repo, run.id) : "",
        });
      }
    }
    // The known-flake list (core_flakes_check_idx's leading column), newest first in code.
    const flakes = (
      await ctx.db
        .selectFrom("core_flakes")
        .select(["check_name", "test_name", "seen_at"])
        .where("repository_id", "=", repository.id)
        .limit(50)
        .execute()
    ).sort((a, b) => b.seen_at.localeCompare(a.seen_at));
    const fence = state.babysit_fence + 1;
    const jobId = newId("job");
    const policy = ctx.scope.policy;
    ctx.write(
      ctx.db.insertInto("core_jobs").values({
        id: jobId,
        work_item_id: w.id,
        project_id: w.project_id,
        org_id: w.org_id,
        stage: "babysit",
        // Resolving a conflict is writing code; the spec's `babysit` role is this one for now.
        role: "implement",
        // Only a runner whose host runs the stage (ADR 0620): an older one would read it as unknown.
        requires: JSON.stringify([...new Set([...(policy?.requires.babysit ?? []), "babysit"])]),
        prompt: babysitPrompt({
          kind: reason.kind,
          item: { number: w.number, title: w.title, branch: w.branch },
          defaultBranch: repository.default_branch,
          headSha: reason.headSha,
          failing,
          knownFlakes: flakes.map((f) => ({
            check: f.check_name,
            test: f.test_name,
            seenAt: f.seen_at,
          })),
        }),
        context: JSON.stringify({ reason, deliveryFence: fence, headSha: reason.headSha }),
        session_timeout_ms: BABYSIT_TIMEOUT_MS,
        created_at: ctx.now,
        pool: stagePool("babysit"),
        shaping: 0,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_delivery_state")
        .set({
          babysit_job_id: jobId,
          babysit_fence: fence,
          babysit_reasons: JSON.stringify([reason]),
        })
        .where("key", "=", state.key)
        .where("babysit_fence", "=", state.babysit_fence),
    );
    ctx.guardChanged("delivery fence unchanged");
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { babysit: reason.kind, jobId, deliveryFence: fence, headSha: reason.headSha },
    });
    return { jobId, deliveryFence: fence, started: true };
  },
});

export const babysitNext = defineOperation({
  name: "babysit.next",
  description:
    "The repository's `babysit` job is over and its result was acted on: closes it, so the next reason starts a new job with a new delivery fence. With `cancel`, a job no runner has claimed is cancelled too (no runner that can babysit is online). Refused with a stale fence. The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  audit: { changesOnly: true },
  input: z.object({
    workItemId,
    deliveryFence,
    /** Also cancel the job if no runner has claimed it (none online can babysit). */
    cancel: z.boolean().default(false),
  }),
  output: z.object({ left: z.array(babysitReasonSchema) }),
  async handler(input, ctx) {
    onlyBabysitter(ctx);
    const w = requireWorkItem(ctx);
    const state = await requireFence(ctx, w, input.deliveryFence);
    const reasons = parseJson<BabysitReason[]>(state.babysit_reasons, []);
    const left = reasons.filter((r) => r.workItemId !== w.id);
    if (state.babysit_job_id === null && left.length === reasons.length) return { left };
    ctx.changed();
    if (input.cancel && state.babysit_job_id) {
      ctx.write(
        ctx.db
          .updateTable("core_jobs")
          .set({ status: "cancelled", finished_at: ctx.now })
          .where("id", "=", state.babysit_job_id)
          .where("status", "=", "queued"),
      );
      // A runner claimed it meanwhile: nothing is closed, and the delivery waits for that run.
      ctx.guardChanged("the babysit job is still unclaimed");
    }
    ctx.write(
      ctx.db
        .updateTable("core_delivery_state")
        .set({ babysit_job_id: null, babysit_reasons: JSON.stringify(left) })
        .where("key", "=", state.key)
        .where("babysit_fence", "=", input.deliveryFence),
    );
    return { left };
  },
});

export const ciRerun = defineOperation({
  name: "ci.rerun",
  description:
    "Rerun a failed required check once, as a flake (spec 53 §4): the babysit job judged it so. Once per check per SHA: a second rerun of the same check on the same SHA is refused in code. Carries the delivery fence of the job whose verdict it acts on. The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    headSha: sha,
    check: z.string().min(1).max(200),
    test: z.string().min(1).max(500).optional(),
    deliveryFence,
  }),
  output: z.object({ checkRunId: z.string() }),
  async handler(input, ctx) {
    onlyBabysitter(ctx);
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    await requireFence(ctx, w, input.deliveryFence);
    // core_ci_reruns' primary key: once per check per SHA.
    const before = await ctx.db
      .selectFrom("core_ci_reruns")
      .select("asked_at")
      .where("repository_id", "=", repository.id)
      .where("head_sha", "=", input.headSha)
      .where("check_name", "=", input.check)
      .executeTakeFirst();
    if (before) {
      throw new OperationError(
        "conflict",
        `${input.check} was already rerun once on ${input.headSha.slice(0, 7)}: a second failure is not a flake`,
      );
    }
    const repo = await repoRef(ctx, repository);
    const run = (await ctx.services.github.listCheckRuns(repo, input.headSha)).find(
      (r) => r.name === input.check && FAILED.has(r.conclusion ?? ""),
    );
    if (!run) {
      throw new OperationError(
        "conflict",
        `no failed ${input.check} on ${input.headSha.slice(0, 7)} to rerun`,
      );
    }
    const asked = await ctx.services.github.rerequestCheckRun(repo, run.id);
    if (!asked.ok) throw new OperationError("unavailable", asked.reason);
    ctx.write(
      ctx.db.insertInto("core_ci_reruns").values({
        repository_id: repository.id,
        head_sha: input.headSha,
        check_name: input.check,
        work_item_id: w.id,
        test_name: input.test ?? null,
        run_url: run.url,
        check_run_id: run.id,
        asked_at: ctx.now,
        passed: null,
      }),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { rerun: input.check, headSha: input.headSha, as: "flake" },
    });
    return { checkRunId: run.id };
  },
});

export const flakeRecord = defineOperation({
  name: "flake.record",
  description:
    "A check the babysitter reran as a flake passed on the same SHA: it joins the repository's known-flake list (`core_flakes`, spec 53 decision 3). Once a check has flaked three times in 14 days, a backlog item to fix it is opened (never released by itself), one at a time per check. The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    headSha: sha,
    check: z.string().min(1).max(200),
    deliveryFence,
  }),
  output: z.object({ flakeId: z.string(), fixWorkItemId: z.string().nullable() }),
  async handler(input, ctx) {
    onlyBabysitter(ctx);
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    const project = requireProject(ctx);
    await requireFence(ctx, w, input.deliveryFence);
    const rerun = await ctx.db
      .selectFrom("core_ci_reruns")
      .select(["test_name", "run_url", "passed"])
      .where("repository_id", "=", repository.id)
      .where("head_sha", "=", input.headSha)
      .where("check_name", "=", input.check)
      .executeTakeFirst();
    if (!rerun || rerun.passed !== null) {
      throw new OperationError(
        "conflict",
        `${input.check} on ${input.headSha.slice(0, 7)} has no rerun waiting to be recorded`,
      );
    }
    const flakeId = newId("flake");
    ctx.write(
      ctx.db.insertInto("core_flakes").values({
        id: flakeId,
        project_id: w.project_id,
        repository_id: repository.id,
        check_name: input.check,
        test_name: rerun.test_name,
        head_sha: input.headSha,
        run_url: rerun.run_url,
        work_item_id: w.id,
        seen_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_ci_reruns")
        .set({ passed: 1 })
        .where("repository_id", "=", repository.id)
        .where("head_sha", "=", input.headSha)
        .where("check_name", "=", input.check),
    );
    // Three times in 14 days, counting this one (core_flakes_check_idx; at most two rows read).
    const since = new Date(Date.parse(ctx.now) - FLAKE_WINDOW_DAYS * 86_400_000).toISOString();
    const earlier = await ctx.db
      .selectFrom("core_flakes")
      .select("id")
      .where("repository_id", "=", repository.id)
      .where("check_name", "=", input.check)
      .where("seen_at", ">=", since)
      .limit(FLAKE_FIX_AFTER - 1)
      .execute();
    let fixWorkItemId: string | null = null;
    if (earlier.length + 1 >= FLAKE_FIX_AFTER) {
      const fix = await ctx.db
        .selectFrom("core_flake_fixes")
        .innerJoin("core_work_items", "core_work_items.id", "core_flake_fixes.work_item_id")
        .select(["core_work_items.id", "core_work_items.status"])
        .where("core_flake_fixes.repository_id", "=", repository.id)
        .where("core_flake_fixes.check_name", "=", input.check)
        .executeTakeFirst();
      const open = fix && fix.status !== "done" && fix.status !== "cancelled";
      if (!open) {
        const created = createWorkItem(ctx, {
          project,
          repositoryId: repository.id,
          title: `Fix the flaky check ${input.check}`.slice(0, 200),
          body: [
            `The babysitter reran \`${input.check}\` as a flake ${FLAKE_FIX_AFTER} times in ${FLAKE_WINDOW_DAYS} days in ${repository.name}, and each rerun passed on the same commit.`,
            rerun.test_name ? `The test it names: \`${rerun.test_name}\`.` : "",
            rerun.run_url ? `The latest: ${rerun.run_url}` : "",
            "Make it deterministic, or take it out of the required checks.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          source: "babysitter",
          requesterUserId: w.requester_user_id,
          number: project.next_number,
          state: "backlog",
        });
        fixWorkItemId = created.id;
        const row = { work_item_id: created.id, created_at: ctx.now };
        ctx.write(
          ctx.db
            .insertInto("core_flake_fixes")
            .values({ repository_id: repository.id, check_name: input.check, ...row })
            .onConflict((oc) => oc.columns(["repository_id", "check_name"]).doUpdateSet(row)),
        );
      }
    }
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: { flake: input.check, headSha: input.headSha, fixWorkItemId },
    });
    return { flakeId, fixWorkItemId };
  },
});

/** Most characters of one file's patch kept for the reopened gate. */
const RESOLUTION_PATCH_MAX = 4_000;
/** Most files a resolution lists. */
const RESOLUTION_FILES_MAX = 50;
/** Most paths read: past it, or past GitHub's own caps, the resolution isn't read (fail closed). */
const RESOLUTION_PATHS_MAX = 250;

export const resolutionSchema = z.object({
  sha,
  /**
   * `clean`: a merge of the approved head and the default branch, read in full: `files` is the
   * resolution. Anything else: review the whole diff, and `reason` says why (`unclean`: not such a
   * merge; `incomplete`: too large to read in full; `failed`: it couldn't be read).
   */
  status: z.enum(["clean", "unclean", "incomplete", "failed"]),
  reason: z.string().nullable(),
  itemHead: sha.nullable(),
  main: sha.nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().nullable(),
      /** Both sides had changed it: the conflict, always listed. False: a deviation, flagged. */
      conflicted: z.boolean(),
      /** Whose content it has: the item's, the default branch's, both (equal), or neither. */
      took: z.enum(["item", "main", "both", "neither"]),
      /** What it means, when it matters (a side discarded, a deviation from the merge). */
      note: z.string().nullable(),
      /** GitHub gave no patch (binary or too large): look at the file. */
      patchOmitted: z.boolean(),
      /** The patch was clipped at RESOLUTION_PATCH_MAX characters. */
      patchTruncated: z.boolean(),
    }),
  ),
  /**
   * Deviations from a plain merge outside the conflict: a path one side changed whose content
   * isn't that side's (main's fix undone, the item's change dropped), or one neither side changed.
   */
  outside: z.array(z.string()),
  /** Resolution files not listed (past RESOLUTION_FILES_MAX), conflicted or not. */
  notShown: z.number(),
  /** What each patch is against: the item's head, so it includes the default branch's changes. */
  patchBase: z.literal("itemHead"),
});
export type Resolution = z.infer<typeof resolutionSchema>;

const unreadable = (
  headSha: string,
  status: "unclean" | "incomplete" | "failed",
  reason: string,
  itemHead: string | null = null,
  main: string | null = null,
): Resolution => ({
  sha: headSha,
  status,
  reason: `${reason}: review the whole diff`,
  itemHead,
  main,
  files: [],
  outside: [],
  notShown: 0,
  patchBase: "itemHead",
});

/**
 * Reads what a resolution changed. Fails closed: anything but a merge of the approved head with a
 * commit on the default branch, read in full, is `unclean` or `incomplete`, and the gate shows the
 * whole diff.
 */
async function readResolution(
  ctx: HandlerContext,
  repo: Awaited<ReturnType<typeof repoRef>>,
  defaultBranch: string,
  headSha: string,
  approvedHead: string,
): Promise<{ summary: Resolution; patches: Record<string, string> }> {
  const github = ctx.services.github;
  const parents = await github.commitParents(repo, headSha);
  const [itemHead, main] = parents;
  if (parents.length !== 2 || !itemHead || !main) {
    return { summary: unreadable(headSha, "unclean", "not a merge commit"), patches: {} };
  }
  // The first parent must be the head that conflicted (the approved one), and the second a commit
  // on the default branch: otherwise a change on top of the approved head would pass for a parent.
  if (itemHead !== approvedHead) {
    return {
      summary: unreadable(
        headSha,
        "unclean",
        `not a merge of the approved head ${approvedHead.slice(0, 7)} (its first parent is ${itemHead.slice(0, 7)})`,
        itemHead,
        main,
      ),
      patches: {},
    };
  }
  const onMain = await github.compareCommits(repo, main, defaultBranch);
  if (onMain.behindBy !== 0) {
    return {
      summary: unreadable(
        headSha,
        "unclean",
        `its second parent ${main.slice(0, 7)} isn't on ${defaultBranch}`,
        itemHead,
        main,
      ),
      patches: {},
    };
  }
  const [ours, theirs, touched] = await Promise.all([
    github.changedPaths(repo, main, itemHead),
    github.changedPaths(repo, itemHead, main),
    github.compareFiles(repo, itemHead, headSha),
  ]);
  // GitHub's compare lists at most 300 files: at that many it may have stopped.
  if (!ours.complete || !theirs.complete || touched.length >= 300) {
    return {
      summary: unreadable(headSha, "incomplete", "too large to read in full", itemHead, main),
      patches: {},
    };
  }
  const both = new Set(ours.paths.filter((p) => theirs.paths.includes(p)));
  const byPath = new Map(touched.map((f) => [f.path, f]));
  const paths = [...new Set([...ours.paths, ...theirs.paths, ...byPath.keys()])];
  if (paths.length > RESOLUTION_PATHS_MAX) {
    return {
      summary: unreadable(headSha, "incomplete", "too large to read in full", itemHead, main),
      patches: {},
    };
  }
  const [atR, atItem, atMain] = await Promise.all([
    github.pathEntries(repo, headSha, paths),
    github.pathEntries(repo, itemHead, paths),
    github.pathEntries(repo, main, paths),
  ]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const itemChanged = new Set(ours.paths);
  const mainChanged = new Set(theirs.paths);
  // Each path against what a plain merge gives (review of #175): changed only by the item, it must
  // be the item's; only on main, main's; on neither side, unchanged. Anything else is a deviation
  // (including taking one side wholesale where the merge takes the other, which would undo a
  // change). Changed on both sides (the conflict) it is always listed, with the side it took.
  type Took = "item" | "main" | "both" | "neither";
  type Judged = { path: string; kind: "conflict" | "deviation"; took: Took };
  const judged = paths.flatMap((p): Judged[] => {
    const tookItem = same(atR[p], atItem[p]);
    const tookMain = same(atR[p], atMain[p]);
    const took: Took =
      tookItem && tookMain ? "both" : tookItem ? "item" : tookMain ? "main" : "neither";
    if (both.has(p)) return [{ path: p, kind: "conflict", took }];
    const expected = mainChanged.has(p) ? tookMain : tookItem;
    return expected ? [] : [{ path: p, kind: "deviation", took }];
  });
  const ordered = [
    ...judged.filter((j) => j.kind === "conflict"),
    ...judged.filter((j) => j.kind === "deviation"),
  ];
  const listed = ordered.slice(0, RESOLUTION_FILES_MAX);
  const patches: Record<string, string> = {};
  const files = listed.map((j) => {
    const f = byPath.get(j.path);
    const patch = f?.patch ?? null;
    if (patch) patches[j.path] = patch.slice(0, RESOLUTION_PATCH_MAX);
    return {
      path: j.path,
      previousPath: f?.previousPath ?? null,
      conflicted: j.kind === "conflict",
      took: j.took,
      note:
        j.kind === "conflict"
          ? j.took === "item"
            ? "took the item's side: the default branch's change is discarded"
            : j.took === "main"
              ? "took the default branch's side: the item's change is discarded"
              : null
          : mainChanged.has(j.path)
            ? "differs from the default branch's change, which a merge would take"
            : itemChanged.has(j.path)
              ? "differs from the item's change, which a merge would take"
              : "changed by the resolution alone",
      patchOmitted: patch === null,
      patchTruncated: (patch?.length ?? 0) > RESOLUTION_PATCH_MAX,
    };
  });
  return {
    summary: {
      sha: headSha,
      status: "clean",
      reason: null,
      itemHead,
      main,
      files,
      outside: ordered.filter((j) => j.kind === "deviation").map((j) => j.path),
      notShown: ordered.length - listed.length,
      patchBase: "itemHead",
    },
    patches,
  };
}

export const babysitResolution = defineOperation({
  name: "babysit.resolution",
  description:
    "Record what the babysitter's conflict resolution changed (spec 53 decision 1: the person sees only the resolution). Only for a merge of the approved head with a commit on the default branch, read in full: the files whose content is neither parent's, which of them both sides had changed (the conflict), the files outside the conflict (flagged), what isn't shown, and each patch (kept apart, read on demand). Anything else, or a read that fails, is recorded as such and the gate shows the whole diff. Carries the babysit job's delivery fence. The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, headSha: sha, approvedHead: sha, deliveryFence }),
  output: z.object({ status: z.string(), files: z.number(), outside: z.array(z.string()) }),
  async handler(input, ctx) {
    onlyBabysitter(ctx);
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    await requireFence(ctx, w, input.deliveryFence);
    const repo = await repoRef(ctx, repository);
    let read: { summary: Resolution; patches: Record<string, string> };
    try {
      read = await readResolution(
        ctx,
        repo,
        repository.default_branch,
        input.headSha,
        input.approvedHead,
      );
    } catch (error) {
      // GitHub failed: recorded, so the gate says the resolution couldn't be read.
      read = {
        summary: unreadable(
          input.headSha,
          "failed",
          `the resolution couldn't be read (${error instanceof Error ? error.message : String(error)})`.slice(
            0,
            500,
          ),
        ),
        patches: {},
      };
    }
    const row = {
      head_sha: input.headSha,
      summary: JSON.stringify(read.summary),
      patches: JSON.stringify(read.patches),
      created_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_babysit_resolutions")
        .values({ work_item_id: w.id, ...row })
        .onConflict((oc) => oc.column("work_item_id").doUpdateSet(row)),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      after: {
        resolution: input.headSha,
        status: read.summary.status,
        files: read.summary.files.length,
        outside: read.summary.outside,
      },
    });
    return {
      status: read.summary.status,
      files: read.summary.files.length,
      outside: read.summary.outside,
    };
  },
});

/** A stored resolution's summary, when it is for `headSha` (none, or the head moved: null). */
export function resolutionFor(
  row: { head_sha: string; summary: string } | undefined,
  headSha: string | null,
): Resolution | null {
  if (!row || row.head_sha !== headSha) return null;
  const parsed = resolutionSchema.safeParse(parseJson(row.summary, null));
  return parsed.success ? parsed.data : null;
}

export const babysitResolutionPatches = defineOperation({
  name: "babysit.resolutionPatches",
  description:
    "The patches of the babysitter's conflict resolution on a work item's current head, for the reopened merge gate (spec 53 decision 1), each against the item's head and clipped. Empty when there is none or the head has moved. For a person who can see the item (its org's members).",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({ headSha: z.string().nullable(), patches: z.record(z.string(), z.string()) }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const row = await ctx.db
      .selectFrom("core_babysit_resolutions")
      .select(["head_sha", "patches"])
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    if (!row || row.head_sha !== w.head_sha) return { headSha: null, patches: {} };
    return { headSha: row.head_sha, patches: parseJson<Record<string, string>>(row.patches, {}) };
  },
});

/** Parses a finished `babysit` run's result; null when it has none that parses. */
export function babysitResult(text: string | null) {
  if (!text) return null;
  const parsed = babysitResultSchema.safeParse(parseJson<unknown>(text, null));
  return parsed.success ? parsed.data : null;
}
