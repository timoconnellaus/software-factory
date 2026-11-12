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

/**
 * The repository a queue lands in: the item's own, else its project's first (items from before
 * 0260 record none, and a project has one repository until per-repository protection, ADR 0490).
 */
export async function queueRepositoryId(
  ctx: Pick<HandlerContext, "db">,
  item: { project_id: string; repository_id: string | null },
): Promise<string | null> {
  if (item.repository_id) return item.repository_id;
  const first = await ctx.db
    .selectFrom("core_repositories")
    .select("id")
    .where("project_id", "=", item.project_id)
    .orderBy("created_at")
    .orderBy("id")
    .executeTakeFirst();
  return first?.id ?? null;
}

/** The open red episode on the repository the item lands in, or null when the line runs. */
export async function lineStopped(
  ctx: Pick<HandlerContext, "db">,
  item: { project_id: string; repository_id: string | null },
): Promise<{ since: string; failing: string[]; headSha: string } | null> {
  const repositoryId = await queueRepositoryId(ctx, item);
  if (!repositoryId) return null;
  const row = await ctx.db
    .selectFrom("core_main_health")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .executeTakeFirst();
  if (!row?.red_since) return null;
  return { since: row.red_since, failing: strings(row.failing), headSha: row.head_sha };
}

export const mainObserve = defineOperation({
  name: "main.observe",
  description:
    "Record whether a repository's default branch is green (spec 53, ADR 0581): read the branch's head and its CI on GitHub (the factory's own checks don't count). A red head opens a red episode, which stops the line: only repairs land until a green head closes it. Called by the GitHub connector on a check suite or a push to the default branch, and safe to repeat.",
  risk: "write",
  actors: ["intake", "agent"],
  permission: "signed-in",
  allowWhenKilled: true,
  input: z.object({
    repo: repoName,
    /** The SHA the event was about; the head is read afresh, so a late event can't go back. */
    headSha: sha.nullable(),
    trigger: z.enum(["ci", "push", "check"]),
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
    const ci = summarizeCi(await github.listCheckRuns(repo, head), github.app.slug);
    const state: MainHealthState =
      ci.state === "success" ? "green" : ci.state === "failure" ? "red" : "pending";
    const before = await ctx.db
      .selectFrom("core_main_health")
      .selectAll()
      .where("repository_id", "=", repository.id)
      .executeTakeFirst();
    const opens = state === "red" && !before?.red_since;
    const closes = state === "green" && !!before?.red_since;
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
    };
    const changed =
      !before ||
      before.head_sha !== row.head_sha ||
      before.state !== row.state ||
      before.failing !== row.failing ||
      before.red_since !== row.red_since;
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
          }),
        ),
    );
    if (changed) {
      ctx.change({
        entity: "main_health",
        id: repository.id,
        before: before ? { state: before.state, sha: before.head_sha } : null,
        after: { state, sha: head, failing: ci.failing },
      });
    }
    const where = `${repository.owner}/${repository.name}`;
    if (opens) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "main.red",
          userId: null,
          workItemId: null,
          title: `${repository.default_branch} is red on ${where}: ${ci.failing.join(", ") || "CI failed"}. Only repairs merge until it is green.`,
          url: `/projects/${project.id}`,
        },
      });
    }
    if (closes) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "main.green",
          userId: null,
          workItemId: null,
          title: `${repository.default_branch} is green again on ${where}.`,
          url: `/projects/${project.id}`,
        },
      });
      // Held deliveries may land now.
      ctx.emit({
        kind: "delivery.wake",
        payload: { projectId: project.id, repositoryId: repository.id },
      });
      // Items from before 0260 record no repository: their queue is keyed by the project alone.
      ctx.emit({ kind: "delivery.wake", payload: { projectId: project.id, repositoryId: null } });
    }
    return { ...mainHealthOf(row), changed };
  },
});

export const workItemMarkRepair = defineOperation({
  name: "workItem.markRepair",
  description:
    "Mark (or unmark) a work item as a repair of a red default branch (spec 53, ADR 0581): a fix or a revert. A repair lands while the line is stopped, ahead of the other approved items in its queue; it still goes through verify and its own merge gate. A person's call (until the babysit job opens repairs itself).",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  input: z.object({ workItemId, repair: z.boolean() }),
  output: z.object({ repair: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
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
