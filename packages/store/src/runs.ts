// Runs: queued by the kernel's run.start, claimed by a runner under a lease with a fencing token,
// and ended by the runner (or by the lease sweep), which applies run.ended or run.failed to the item.
import { guardChanged, toStatement } from "@software-factory/db";
import type { Actor } from "@software-factory/flow";
import { sql } from "kysely";
import { flowDb, iso, StoreError } from "./db.ts";
import type { FlowRunsTable, RunStatus } from "./schema.ts";
import { advance, type Item } from "./step.ts";

export interface RunResult {
  outcome: "done" | "rejected";
  summary: string;
}

export interface Run {
  id: string;
  orgId: string;
  itemId: string;
  agentId: string;
  statusId: string;
  stay: number;
  brief: string;
  status: RunStatus;
  runnerId: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  result: RunResult | null;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

function toRun(row: FlowRunsTable): Run {
  return {
    id: row.id,
    orgId: row.org_id,
    itemId: row.item_id,
    agentId: row.agent_id,
    statusId: row.status_id,
    stay: row.stay,
    brief: row.brief,
    status: row.status,
    runnerId: row.runner_id,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result === null ? null : (JSON.parse(row.result) as RunResult),
    error: row.error,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  };
}

/** What a runner needs to do a claimed run. */
export interface ClaimedRun {
  id: string;
  orgId: string;
  itemId: string;
  statusId: string;
  stay: number;
  brief: string;
  fencingToken: number;
  leaseExpiresAt: string;
  item: { number: number; title: string; body: string };
  /** Null when the workflow names an agent the org doesn't have. */
  agent: { id: string; name: string; instructions: string } | null;
}

const STOPPED_RESPONDING = "The runner stopped responding.";

/**
 * Claims the oldest queued run for `runnerId` among the runs it serves: one query picks it
 * (flow_runs_queue_idx), one guarded update claims it. Null when nothing it serves is queued, or
 * another runner claimed it first.
 *
 * A runner serves, as in the old core's placement (core_runners, core_runner_shares, ADR 0038), the
 * items its owner created, and every item of an org it is shared into (`scope = 'org'`).
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
    .innerJoin("flow_items as i", "i.id", "r.item_id")
    .leftJoin("flow_agents as a", "a.id", "r.agent_id")
    .select(["r.id", "r.org_id", "r.item_id", "r.agent_id", "r.status_id", "r.stay", "r.brief"])
    .select(["r.fencing_token", "i.number", "i.title", "i.body"])
    .select(["a.name as agent_name", "a.instructions as agent_instructions"])
    .where("r.status", "=", sql.lit("queued"))
    .where(
      sql<boolean>`(i.created_by = (SELECT owner_user_id FROM core_runners WHERE id = ${runnerId})
        OR EXISTS (SELECT 1 FROM core_runner_shares s WHERE s.runner_id = ${runnerId}
          AND s.scope = 'org' AND s.scope_id = r.org_id))`,
    )
    .orderBy("r.created_at")
    .orderBy("r.id")
    .limit(1)
    .executeTakeFirst();
  if (!run) return null;
  const leaseExpiresAt = iso(now + leaseMs);
  const claimed = await db
    .updateTable("flow_runs")
    .set({
      status: "claimed",
      runner_id: runnerId,
      fencing_token: sql<number>`fencing_token + 1`,
      lease_expires_at: leaseExpiresAt,
      claimed_at: iso(now),
    })
    .where("id", "=", run.id)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (!claimed.numUpdatedRows) return null;
  return {
    id: run.id,
    orgId: run.org_id,
    itemId: run.item_id,
    statusId: run.status_id,
    stay: run.stay,
    brief: run.brief,
    fencingToken: run.fencing_token + 1,
    leaseExpiresAt,
    item: { number: run.number, title: run.title, body: run.body },
    agent:
      run.agent_name === null
        ? null
        : {
            id: run.agent_id,
            name: run.agent_name,
            instructions: run.agent_instructions ?? "",
          },
  };
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

/** One run, or null. */
export async function getRun(d1: D1Database, runId: string): Promise<Run | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  return row ? toRun(row) : null;
}

/**
 * Ends a claimed run: marks it, then applies `event` to its item, in one batch. With `lapsedBefore`
 * the run's update also requires its lease to have lapsed before then, at write time, so a lease
 * renewed after the sweep read it is never failed (the batch is a conflict instead).
 */
async function end(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  ended: { status: "done"; result: RunResult } | { status: "failed"; error: string },
  lapsedBefore?: string,
): Promise<Item> {
  const db = flowDb(d1);
  const run = await db
    .selectFrom("flow_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) throw new StoreError("not_found", `No run ${runId}.`);
  if (run.status !== "claimed" || run.fencing_token !== fencingToken) {
    throw new StoreError(
      "stale_run",
      `Run ${runId} is ${run.status} with fencing token ${run.fencing_token}; this call holds ${fencingToken}.`,
    );
  }
  let finish = db
    .updateTable("flow_runs")
    .set({
      status: ended.status,
      result: ended.status === "done" ? JSON.stringify(ended.result) : null,
      error: ended.status === "failed" ? ended.error : null,
      finished_at: iso(),
    })
    .where("id", "=", runId)
    .where("status", "=", "claimed")
    .where("fencing_token", "=", fencingToken);
  if (lapsedBefore !== undefined) finish = finish.where("lease_expires_at", "<", lapsedBefore);
  const agent: Actor = { kind: "agent", id: run.agent_id };
  const summary = ended.status === "done" ? ended.result.summary.trim() : "";
  return advance(
    d1,
    run.item_id,
    ended.status === "done"
      ? { type: "run.ended", stay: run.stay, outcome: ended.result.outcome }
      : { type: "run.failed", stay: run.stay, error: ended.error },
    agent,
    {
      before: [toStatement(d1, finish), guardChanged(d1, "flow_runs.fencing_token")],
      ...(summary ? { comment: { actor: agent, text: summary } } : {}),
    },
  );
}

/** The agent finished: the item moves on (or back). A stale fencing token is refused. */
export function finishRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  result: RunResult,
): Promise<Item> {
  return end(d1, runId, fencingToken, { status: "done", result });
}

/** The run failed: the item stops with the error until someone retries it. */
export function failRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  error: string,
): Promise<Item> {
  return end(d1, runId, fencingToken, { status: "failed", error });
}

/**
 * Fails one claimed run as the lease sweep does: only if, at write time, it still holds
 * `fencingToken` and its lease lapsed before `now`. False when it ended, was claimed again, or its
 * runner renewed the lease after the sweep read it.
 */
export async function expireRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  now: number,
): Promise<boolean> {
  try {
    await end(d1, runId, fencingToken, { status: "failed", error: STOPPED_RESPONDING }, iso(now));
    return true;
  } catch (error) {
    if (error instanceof StoreError) return false;
    throw error;
  }
}

/**
 * Fails claimed runs whose lease lapsed before `now`, oldest first, through expireRun. Reads
 * flow_runs_lease_idx. At most 10 a call (AGENTS.md cost rule 8: each one is a few queries); a run
 * that ended or was renewed meanwhile is skipped. Returns how many it failed.
 */
export async function expireRuns(d1: D1Database, now: number, limit: number): Promise<number> {
  const lapsed = await flowDb(d1)
    .selectFrom("flow_runs")
    .select(["id", "fencing_token"])
    .where("status", "=", sql.lit("claimed"))
    .where("lease_expires_at", "<", iso(now))
    .orderBy("lease_expires_at")
    .limit(Math.min(limit, 10))
    .execute();
  let failed = 0;
  for (const run of lapsed) {
    if (await expireRun(d1, run.id, run.fencing_token, now)) failed++;
  }
  return failed;
}

/** An item's runs, by stay. */
export async function itemRuns(d1: D1Database, itemId: string): Promise<Run[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_runs")
    .selectAll()
    .where("item_id", "=", itemId)
    .orderBy("stay")
    .execute();
  return rows.map(toRun);
}
