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

/** The latest start or completion among the runs, as GitHub gives it; '' when it gives none. */
function latestEvent(runs: readonly CheckRunInfo[]): string {
  let at = "";
  for (const r of runs) {
    for (const t of [r.startedAt, r.completedAt]) if (t && t > at) at = t;
  }
  return at;
}

/**
 * Whether an observation `(headSha, headAt, eventAt)` is newer than the stored one: a later head
 * commit, or the same head with a later (or equal) check event. Mirrored in SQL by `newerGuard`.
 */
function isNewer(
  before: Pick<MainHealthRow, "head_sha" | "head_at" | "event_at"> | undefined,
  o: { headSha: string; headAt: string; eventAt: string },
): boolean {
  if (!before) return true;
  if (o.headAt > before.head_at) return true;
  if (o.headSha === before.head_sha) return o.eventAt >= before.event_at;
  return o.headAt === before.head_at && o.eventAt > before.event_at;
}

export const mainObserve = defineOperation({
  name: "main.observe",
  description:
    "Record whether a repository's default branch is green (spec 53, ADR 0581): read the branch's head and its CI on GitHub (the factory's own checks don't count; a run cancelled before it started doesn't either). A red head opens a red episode, which stops the line: only repairs land until a green head closes it. Observations are ordered by the head commit's time and the latest check event GitHub gives; an older one never overwrites a newer one, and one that changes nothing writes nothing. Called by the GitHub connector on a check suite or a push to the default branch, and by the babysitter's held recheck; safe to repeat.",
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
    const [headAt, runs] = await Promise.all([
      github.commitTime(repo, head),
      github.listCheckRuns(repo, head),
    ]);
    const counted = countedRuns(runs);
    const ci = summarizeCi(counted, github.app.slug);
    const observed = { headSha: head, headAt: headAt ?? "", eventAt: latestEvent(counted) };
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
      head_at: observed.headAt,
      event_at: observed.eventAt,
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
    // Only a change is written (and audited): the same state seen again is not a row (Cloudflare
    // cost rule). The newer observation's times wait for the next change.
    if (!changed) return { ...mainHealthOf(row), changed: false };
    // Guarded in this batch: another observation that committed meanwhile and is newer than this
    // one refuses it (a push and a check suite read together; GitHub's answers can cross).
    ctx.write(
      ctx.d1
        .prepare(
          `INSERT INTO core_batch_guard (name, ok) SELECT 'main.observe:newer', NOT EXISTS (
             SELECT 1 FROM core_main_health WHERE repository_id = ?1 AND NOT (
               head_at < ?2 OR (head_sha = ?3 AND event_at <= ?4)
               OR (head_at = ?2 AND event_at < ?4)))`,
        )
        .bind(repository.id, observed.headAt, head, observed.eventAt),
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
            head_at: row.head_at,
            event_at: row.event_at,
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
