// The babysitter's view of the default branch (spec 53, ADR 0581): whether each repository's `main`
// is green, and the red episode that stops the line. `main.observe` records it from GitHub (the
// connector on a check suite or a push to the default branch); while an episode is open the
// deliverer lands only repairs, and every other approved delivery is held. `delivery.status` is the
// Factory Overview's Babysitter line; `workItem.markRepair` is how a person says a fix repairs main.
import type { CoreDatabase, MainHealthState } from "@software-factory/db";
import type { Selectable } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { approverIds } from "../scope.ts";
import type { CheckRunInfo } from "../services.ts";
import { summarizeCi } from "../verify/ci.ts";
import { autoApprovedKey, holdAutoApproval } from "./auto-approve.ts";
import { queuedEntries } from "./merge-queue.ts";
import {
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

type MainHealthRow = Selectable<CoreDatabase["core_main_health"]>;

const mainHealth = z.object({
  state: z.enum(["green", "red", "pending"]),
  headSha: z.string(),
  failing: z.array(z.string()),
  lastGreenSha: z.string().nullable(),
  /** The open red episode's start; while set, the line is stopped. */
  redSince: z.string().nullable(),
  firstRedSha: z.string().nullable(),
  checkedAt: z.string(),
});

function strings(text: string | null | undefined): string[] {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function mainHealthOf(row: MainHealthRow): z.infer<typeof mainHealth> {
  return {
    state: row.state,
    headSha: row.head_sha,
    failing: strings(row.failing),
    lastGreenSha: row.last_green_sha,
    redSince: row.red_since,
    firstRedSha: row.first_red_sha,
    checkedAt: row.checked_at,
  };
}

export async function lineStopped(
  ctx: Pick<HandlerContext, "db">,
  item: { repository_id: string | null },
): Promise<{ since: string; failing: string[]; headSha: string } | null> {
  // An item with no repository is never the babysitter's (ADR 0586), so never held.
  const repositoryId = item.repository_id;
  if (!repositoryId) return null;
  const row = await ctx.db
    .selectFrom("core_main_health")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .executeTakeFirst();
  if (!row?.red_since) return null;
  return { since: row.red_since, failing: strings(row.failing), headSha: row.head_sha };
}

/**
 * Who hears that `main` is red (spec 53, owner question 4, not yet answered): the recommendation, the
 * project's approvers. One place, so a different answer is a change here only. Recorded on the
 * episode (`core_main_health.audience`) for the Inbox card and used for the push.
 */
export async function mainRedAudience(ctx: HandlerContext, orgId: string): Promise<string[]> {
  return approverIds(ctx.db, orgId, ctx.scope.policy);
}

/** Check runs that count toward `main`'s health: a run superseded before it started doesn't. */
function countedRuns(runs: readonly CheckRunInfo[]): CheckRunInfo[] {
  return runs.filter(
    (r) =>
      r.conclusion !== "stale" &&
      !(r.conclusion === "cancelled" && !r.startedAt) &&
      !(r.conclusion === "cancelled" && r.startedAt && r.startedAt === r.completedAt),
  );
}

/**
 * GitHub's newest run among the head's runs: a rerun is a new check run with a higher id (the
 * check-runs API carries no run attempt), so it orders two reads at the same moment. 0 when none.
 */
function newestRun(runs: readonly CheckRunInfo[]): number {
  let n = 0;
  for (const r of runs) {
    const id = Number(r.id);
    if (Number.isSafeInteger(id) && id > n) n = id;
  }
  return n;
}

/**
 * Whether an observation is newer than the stored one (second review of #104). Only what the engine
 * itself knows orders them: which commit is the branch's head is what GitHub reports when the
 * engine reads it, and observations are ordered by when the engine read (`observed_at`, this call's
 * start), GitHub's newest run breaking a tie. Never by commit dates: whoever pushes sets those, so a
 * force-push back to an older commit, or a future-dated commit, must not freeze the state.
 */
function isNewer(
  before: Pick<MainHealthRow, "observed_at" | "attempt"> | undefined,
  o: { observedAt: string; attempt: number },
): boolean {
  if (!before) return true;
  if (o.observedAt !== before.observed_at) return o.observedAt > before.observed_at;
  return o.attempt > before.attempt;
}

export const mainObserve = defineOperation({
  name: "main.observe",
  description:
    "Record whether a repository's default branch is green (spec 53, ADR 0581): read the branch's head and its CI on GitHub (the factory's own checks don't count; a run cancelled before it started doesn't either). A red head opens a red episode, which stops the line: only repairs land until a green head closes it. Observations are ordered by when the engine read them (the branch's head is what GitHub reports then; never commit dates, which the pusher sets), GitHub's newest run breaking a tie; an older one never overwrites a newer one, and one that changes nothing writes no audit row. Called by the GitHub connector on a check suite or a push to the default branch, and by the babysitter's held recheck; safe to repeat.",
  risk: "write",
  actors: ["intake", "agent"],
  permission: "signed-in",
  allowWhenKilled: true,
  quietWhenUnchanged: true,
  input: z.object({
    repo: repoName,
    /** The SHA the event was about; the head is read afresh, so a late event can't go back. */
    headSha: sha.nullable(),
    trigger: z.enum(["ci", "push", "check", "recheck"]),
  }),
  output: mainHealth.extend({ changed: z.boolean() }),
  scope: async (input, db) => repositoryForRepo(db, input.repo),
  async handler(_input, ctx) {
    const repository = requireRepository(ctx);
    const project = requireProject(ctx);
    const repo = await repoRef(ctx, repository);
    const github = ctx.services.github;
    const head = await github.getBranchSha(repo, repository.default_branch);
    if (!head) throw new OperationError("not_found", `no ${repository.default_branch} branch`);
    const counted = countedRuns(await github.listCheckRuns(repo, head));
    const ci = summarizeCi(counted, github.app.slug);
    const observed = { observedAt: ctx.now, attempt: newestRun(counted) };
    const state: MainHealthState =
      ci.state === "success" ? "green" : ci.state === "failure" ? "red" : "pending";
    const before = await ctx.db
      .selectFrom("core_main_health")
      .selectAll()
      .where("repository_id", "=", repository.id)
      .executeTakeFirst();
    // An observation older than the stored one (read before it, or about an older head) changes
    // nothing: the stored one stands.
    if (!isNewer(before, observed)) {
      return { ...mainHealthOf(before as MainHealthRow), changed: false };
    }
    const opens = state === "red" && !before?.red_since;
    const closes = state === "green" && !!before?.red_since;
    const audience = opens ? await mainRedAudience(ctx, project.org_id) : null;
    const row: MainHealthRow = {
      repository_id: repository.id,
      project_id: project.id,
      head_sha: head,
      state,
      failing: JSON.stringify(ci.failing),
      last_green_sha: state === "green" ? head : (before?.last_green_sha ?? null),
      red_since: state === "green" ? null : opens ? ctx.now : (before?.red_since ?? null),
      first_red_sha: state === "green" ? null : opens ? head : (before?.first_red_sha ?? null),
      checked_at: ctx.now,
      observed_at: observed.observedAt,
      attempt: observed.attempt,
      audience: audience
        ? JSON.stringify(audience)
        : state === "green"
          ? "[]"
          : (before?.audience ?? "[]"),
    };
    const changed =
      !before ||
      before.head_sha !== row.head_sha ||
      before.state !== row.state ||
      before.failing !== row.failing ||
      before.red_since !== row.red_since;
    // The same state seen again writes nothing, not even its time (no row, no audit: Cloudflare
    // cost rule 12). The cost: a read that started before this one and saw another state can still
    // commit after it; that needs main to flap within one read's few seconds, and the next check
    // suite or held recheck corrects it.
    if (!changed) return { ...mainHealthOf(row), changed: false };
    // Guarded in this batch: another observation that committed meanwhile and is newer than this
    // one refuses it (a push and a check suite read together; GitHub's answers can cross).
    ctx.write(
      ctx.d1
        .prepare(
          `INSERT INTO core_batch_guard (name, ok) SELECT 'main.observe:newer', NOT EXISTS (
             SELECT 1 FROM core_main_health WHERE repository_id = ?1 AND
               (observed_at > ?2 OR (observed_at = ?2 AND attempt >= ?3)))`,
        )
        .bind(repository.id, observed.observedAt, observed.attempt),
    );
    ctx.write(
      ctx.db
        .insertInto("core_main_health")
        .values(row)
        .onConflict((oc) =>
          oc.column("repository_id").doUpdateSet({
            head_sha: row.head_sha,
            state: row.state,
            failing: row.failing,
            last_green_sha: row.last_green_sha,
            red_since: row.red_since,
            first_red_sha: row.first_red_sha,
            checked_at: row.checked_at,
            observed_at: row.observed_at,
            attempt: row.attempt,
            audience: row.audience,
          }),
        ),
    );
    ctx.change({
      entity: "main_health",
      id: repository.id,
      before: before ? { state: before.state, sha: before.head_sha } : null,
      after: { state, sha: head, failing: ci.failing },
    });
    const where = `${repository.owner}/${repository.name}`;
    // Dark factory mode (ADR 0515 §7, review of #152): the window opens when an auto-approved merge
    // lands (`<time> <merge commit>`) and closes once main's CI is green on that commit or a later
    // one; red in between holds the project. A point read by key, on a change only.
    if (opens || state === "green") {
      const key = autoApprovedKey(project.id);
      const marker = (
        await ctx.db
          .selectFrom("core_meta")
          .select("value")
          .where("key", "=", key)
          .executeTakeFirst()
      )?.value;
      const mergeSha = marker?.split(" ")[1] ?? null;
      if (marker && opens)
        await holdAutoApproval(
          ctx,
          project,
          `${repository.default_branch} went red on ${where} after an auto-approved merge${mergeSha ? ` (${mergeSha.slice(0, 7)})` : ""}`,
          [head],
        );
      if (marker && opens) ctx.write(ctx.db.deleteFrom("core_meta").where("key", "=", key));
      if (marker && state === "green" && mergeSha) {
        // Green on the merge commit or a later one (it contains the merge): the window closes.
        const contains =
          head === mergeSha ||
          (await github.compareCommits(repo, mergeSha, head).catch(() => null))?.behindBy === 0;
        if (contains) ctx.write(ctx.db.deleteFrom("core_meta").where("key", "=", key));
      }
    }
    if (opens) {
      for (const userId of audience ?? []) {
        ctx.emit({
          kind: "notify",
          payload: {
            event: "main.red",
            userId,
            workItemId: null,
            title: `${repository.default_branch} is red on ${where}: ${ci.failing.join(", ") || "CI failed"}. Only repairs merge until it is green.`,
            url: `/projects/${project.id}`,
          },
        });
      }
    }
    if (closes) {
      for (const userId of strings(before?.audience)) {
        ctx.emit({
          kind: "notify",
          payload: {
            event: "main.green",
            userId,
            workItemId: null,
            title: `${repository.default_branch} is green again on ${where}.`,
            url: `/projects/${project.id}`,
          },
        });
      }
      // The episode is over, and so are its repairs: an item marked for this one must not skip the
      // hold in the next (second review of #104). Partial index core_work_items_repair_idx.
      ctx.write(
        ctx.db
          .updateTable("core_work_items")
          .set({ repairs_main: 0, updated_at: ctx.now })
          .where("repository_id", "=", repository.id)
          .where("repairs_main", "=", 1),
      );
      // Held deliveries may land now (one wake: the queue is keyed by the repository, ADR 0586).
      ctx.emit({
        kind: "delivery.wake",
        payload: { projectId: project.id, repositoryId: repository.id },
      });
    }
    return { ...mainHealthOf(row), changed: true };
  },
});

export const workItemMarkRepair = defineOperation({
  name: "workItem.markRepair",
  description:
    "Mark (or unmark) a work item as a repair of a red default branch (spec 53, ADR 0581): a fix or a revert. Only while the line is stopped on the item's repository; a repair then lands ahead of the other approved items in its queue (only while red), still through verify and its own merge gate. A person's call, confirmed like a gate decision: from the browser, or a desktop or phone with a presence proof for this exact call; never from the CLI, MCP or an agent (until the babysit job opens repairs itself).",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  presenceDecidable: true,
  input: z.object({ workItemId, repair: z.boolean() }),
  output: z.object({ repair: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (input.repair) {
      if (!w.repository_id) {
        throw new OperationError("conflict", `work item #${w.number} has no repository`);
      }
      const stopped = await lineStopped(ctx, w);
      if (!stopped) {
        throw new OperationError(
          "conflict",
          `the line isn't stopped on work item #${w.number}'s repository: a repair is only for a red default branch`,
        );
      }
      // Guarded: main turning green before this commits refuses it.
      ctx.guardExists(
        "line stopped",
        ctx.db
          .selectFrom("core_main_health")
          .select("repository_id")
          .where("repository_id", "=", w.repository_id)
          .where("red_since", "is not", null),
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ repairs_main: input.repair ? 1 : 0, updated_at: ctx.now })
        .where("id", "=", w.id),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { repairsMain: w.repairs_main === 1 },
      after: { repairsMain: input.repair },
    });
    ctx.emit({
      kind: "delivery.wake",
      payload: { projectId: w.project_id, repositoryId: w.repository_id },
    });
    return { repair: input.repair };
  },
});

const deliveryState = z.enum(["merging", "waiting", "held"]);

export const deliveryStatus = defineOperation({
  name: "delivery.status",
  description:
    "The babysitter's line for a project (spec 53): for each repository, whether its default branch is green or red (since when, the failing checks) and the approved work items waiting to land, in order, each `merging` (the head), `waiting` or `held` (main is red and it is not a repair).",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    repositories: z.array(
      z.object({
        repositoryId: z.string(),
        owner: z.string(),
        name: z.string(),
        branch: z.string(),
        /** Null until the babysitter has seen the default branch's CI. */
        main: mainHealth.nullable(),
        deliveries: z.array(
          z.object({
            workItemId: z.string(),
            number: z.number(),
            title: z.string(),
            position: z.number(),
            state: deliveryState,
            repair: z.boolean(),
            /** Who lands it: the babysitter, or the item's own Workflow (before v11). */
            driver: z.enum(["workflow", "babysitter"]),
            headSha: z.string(),
            enqueuedAt: z.string(),
          }),
        ),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const repositories = await ctx.db
      .selectFrom("core_repositories")
      .selectAll()
      .where("project_id", "=", project.id)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const health = await ctx.db
      .selectFrom("core_main_health")
      .selectAll()
      .where("project_id", "=", project.id)
      .execute();
    const entries = await queuedEntries(ctx, project.id);
    const first = repositories[0]?.id ?? null;
    return {
      repositories: repositories.map((r) => {
        const h = health.find((x) => x.repository_id === r.id) ?? null;
        const stopped = !!h?.red_since;
        const mine = entries.filter((e) => (e.repository_id ?? first) === r.id);
        return {
          repositoryId: r.id,
          owner: r.owner,
          name: r.name,
          branch: r.default_branch,
          main: h ? mainHealthOf(h) : null,
          deliveries: mine.map((e, i) => ({
            workItemId: e.work_item_id,
            number: e.number,
            title: e.title,
            position: i + 1,
            state:
              stopped && e.repairs_main !== 1 && e.driver === "babysitter"
                ? ("held" as const)
                : i === 0
                  ? ("merging" as const)
                  : ("waiting" as const),
            repair: e.repairs_main === 1,
            driver: e.driver,
            headSha: e.head_sha,
            enqueuedAt: e.enqueued_at,
          })),
        };
      }),
    };
  },
});
