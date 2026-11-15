// Claiming a run: a runner takes the oldest queued run it serves under a lease with a fencing
// token, and renews that lease while it works. A run on a project with a repository gets its
// item's branch here (one per item, reused by every later run on it).
import { toStatement } from "@software-factory/db";
import { sql } from "kysely";
import { parseMcp } from "./agents.ts";
import { flowDb, iso } from "./db.ts";
import { type ProjectRepo, repoOf } from "./projects.ts";

/** What a runner needs to do a claimed run. */
export interface ClaimedRun {
  id: string;
  orgId: string;
  itemId: string | null;
  chatId: string | null;
  statusId: string;
  stay: number;
  brief: string;
  fencingToken: number;
  leaseExpiresAt: string;
  /**
   * An item's run: the item, with its branch (set by this claim when its project has a repository)
   * and the head the last run that ended `done` pushed there. Null for a chat's run.
   */
  item: {
    number: number;
    title: string;
    body: string;
    branch: string | null;
    /** This claim set the item's branch: no earlier run worked on it. */
    firstOnBranch: boolean;
    headSha: string | null;
  } | null;
  /** An item's run: its project's key and repository. Null for a chat's run. */
  project: { key: string; repo: ProjectRepo | null } | null;
  /** A chat's run: the chat. Null for an item's run. */
  chat: { title: string } | null;
  /** Null when the workflow names an agent the org doesn't have. */
  agent: { id: string; name: string; instructions: string; mcp: string[] } | null;
}

/**
 * Claims the oldest queued run for `runnerId` among the runs it serves: one query picks it
 * (flow_runs_queue_idx), one guarded update claims it. Null when nothing it serves is queued, or
 * another runner claimed it first.
 *
 * A runner serves, as in the old core's placement (core_runners, core_runner_shares, ADR 0038), the
 * items and chats its owner created, and every one of an org it is shared into (`scope = 'org'`).
 * A run's item or chat is a left join by primary key: a run has exactly one of them.
 */
export async function claimRun(
  d1: D1Database,
  runnerId: string,
  now: number,
  leaseMs: number,
): Promise<ClaimedRun | null> {
  const db = flowDb(d1);
  // `'queued'` is a literal, not a parameter, so SQLite can use the partial index. The runner's
  // owner and its shares are point reads by primary key.
  const run = await db
    .selectFrom("flow_runs as r")
    .leftJoin("flow_items as i", "i.id", "r.item_id")
    .leftJoin("flow_projects as p", "p.id", "i.project_id")
    .leftJoin("flow_chats as c", "c.id", "r.chat_id")
    .leftJoin("flow_agents as a", "a.id", "r.agent_id")
    .select(["r.id", "r.org_id", "r.item_id", "r.chat_id", "r.agent_id", "r.status_id", "r.stay"])
    .select(["i.branch", "i.head_sha", "p.key as project_key", "p.repo_owner", "p.repo_name"])
    .select(["p.repo_default_branch", "p.repo_installation_id"])
    .select([
      "r.brief",
      "r.fencing_token",
      "i.number",
      "i.title",
      "i.body",
      "c.title as chat_title",
    ])
    .select(["a.name as agent_name", "a.instructions as agent_instructions", "a.mcp as agent_mcp"])
    .where("r.status", "=", sql.lit("queued"))
    .where(
      sql<boolean>`(COALESCE(i.created_by, c.created_by) =
          (SELECT owner_user_id FROM core_runners WHERE id = ${runnerId})
        OR EXISTS (SELECT 1 FROM core_runner_shares s WHERE s.runner_id = ${runnerId}
          AND s.scope = 'org' AND s.scope_id = r.org_id))`,
    )
    .orderBy("r.created_at")
    .orderBy("r.id")
    .limit(1)
    .executeTakeFirst();
  if (!run) return null;
  const leaseExpiresAt = iso(now + leaseMs);
  const repo = run.item_id !== null ? repoOf(run) : null;
  // A run on a project with a repository works on its item's branch, one per item, set here by the
  // item's first such run and reused by every later one.
  const branch =
    repo && run.number !== null
      ? (run.branch ?? itemBranch(run.project_key ?? "", run.number))
      : null;
  const claim = db
    .updateTable("flow_runs")
    .set({
      status: "claimed",
      runner_id: runnerId,
      fencing_token: sql<number>`fencing_token + 1`,
      lease_expires_at: leaseExpiresAt,
      claimed_at: iso(now),
      branch,
    })
    .where("id", "=", run.id)
    .where("status", "=", "queued");
  if (branch && run.branch === null && run.item_id !== null) {
    // The item's branch is the same whichever claim sets it, so this needs no guard of its own.
    const setBranch = db
      .updateTable("flow_items")
      .set({ branch })
      .where("id", "=", run.item_id)
      .where("branch", "is", null);
    const [claimed] = await d1.batch([toStatement(d1, claim), toStatement(d1, setBranch)]);
    if (!claimed?.meta.changes) return null;
  } else {
    const claimed = await claim.executeTakeFirst();
    if (!claimed.numUpdatedRows) return null;
  }
  return {
    id: run.id,
    orgId: run.org_id,
    itemId: run.item_id,
    chatId: run.chat_id,
    statusId: run.status_id,
    stay: run.stay,
    brief: run.brief,
    fencingToken: run.fencing_token + 1,
    leaseExpiresAt,
    item:
      run.item_id !== null && run.number !== null
        ? {
            number: run.number,
            title: run.title ?? "",
            body: run.body ?? "",
            branch,
            headSha: run.head_sha,
            firstOnBranch: branch !== null && run.branch === null,
          }
        : null,
    project: run.item_id !== null ? { key: run.project_key ?? "", repo } : null,
    chat: run.chat_id !== null ? { title: run.chat_title ?? "" } : null,
    agent:
      run.agent_name === null
        ? null
        : {
            id: run.agent_id,
            name: run.agent_name,
            instructions: run.agent_instructions ?? "",
            mcp: parseMcp(run.agent_mcp),
          },
  };
}

/**
 * The branch of an item numbered `number` in a project keyed `key`: `factory/flow-<key>-<number>`,
 * the key lower-cased with anything but letters and digits made a dash. Under `factory/` (the only
 * place the App may push) but never `factory/<digits>-…`, which is the old core's work items.
 */
export function itemBranch(key: string, number: number): string {
  const slug =
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item";
  return `factory/flow-${slug}-${number}`;
}

/** Extends the lease of a run this runner holds. False when it no longer holds it. */
export async function renewLease(
  d1: D1Database,
  runId: string,
  runnerId: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const result = await flowDb(d1)
    .updateTable("flow_runs")
    .set({ lease_expires_at: iso(now + leaseMs) })
    .where("id", "=", runId)
    .where("runner_id", "=", runnerId)
    .where("status", "=", "claimed")
    .executeTakeFirst();
  return Boolean(result.numUpdatedRows);
}
