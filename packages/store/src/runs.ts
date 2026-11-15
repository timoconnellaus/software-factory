// Runs: queued by the kernel's run.start (or by a chat message, chats.ts), claimed by a runner under
// a lease with a fencing token, and ended by the runner (or by the lease sweep), which applies
// run.ended or run.failed to the item, or, for a chat run, adds the agent's reply (chat-runs.ts).
import { guardChanged, toStatement } from "@software-factory/db";
import type { Actor } from "@software-factory/flow";
import { sql } from "kysely";
import { expireChatRun } from "./chat-runs.ts";
import { flowDb, iso, StoreError } from "./db.ts";
import { type Run, type RunResult, toRun } from "./run-row.ts";
import type { FlowRunRow } from "./schema.ts";
import { advance, type Item, type Stepped } from "./step.ts";

export { type ClaimedRun, claimRun, itemBranch, renewLease } from "./claim.ts";
export { type Run, type RunResult, toRun } from "./run-row.ts";

const STOPPED_RESPONDING = "The runner stopped responding.";

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
 * How a run ended. `stopWith` records it done but stops the item with that error instead. `pushed`
 * is the branch and head a run with a repository handed back: stored on the run, and the head
 * copied to the item when the run is done.
 */
export type RunEnding =
  | { status: "done"; result: RunResult; stopWith?: string; pushed?: Pushed }
  | { status: "failed"; error: string; pushed?: Pushed };

/** The branch a run pushed and its head. */
export interface Pushed {
  branch: string;
  headSha: string | null;
}

/** A run that ended: the run as it now is, its item after the step, and the step's effects. */
export interface EndedRun extends Stepped {
  run: Run;
}

/**
 * Ends a claimed run: marks it, then applies `run.ended` (or `run.failed`) to its item, in one
 * batch. With `lapsedBefore` the run's update also requires its lease to have lapsed before then,
 * at write time, so a lease renewed after the sweep read it is never failed (the batch is a
 * conflict instead). A stale fencing token is refused.
 */
export async function endRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  ended: RunEnding,
  lapsedBefore?: string,
): Promise<EndedRun> {
  const db = flowDb(d1);
  const run = await db
    .selectFrom("flow_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) throw new StoreError("not_found", `No run ${runId}.`);
  // A chat's run ends through chat-runs.ts (endChatRun): it has no item to step.
  if (run.item_id === null) throw new StoreError("invalid", `Run ${runId} is a chat's run.`);
  const itemId = run.item_id;
  if (run.status !== "claimed" || run.fencing_token !== fencingToken) {
    throw new StoreError(
      "stale_run",
      `Run ${runId} is ${run.status} with fencing token ${run.fencing_token}; this call holds ${fencingToken}.`,
    );
  }
  const now = iso();
  // Only the run's own branch counts: a hand-back naming another is recorded without it.
  const pushed = ended.pushed && ended.pushed.branch === run.branch ? ended.pushed : null;
  const after: FlowRunRow = {
    ...run,
    status: ended.status,
    result: ended.status === "done" ? JSON.stringify(ended.result) : null,
    error: ended.status === "failed" ? ended.error : null,
    finished_at: now,
    head_sha: pushed?.headSha ?? run.head_sha,
  };
  let finish = db
    .updateTable("flow_runs")
    .set({
      status: after.status,
      result: after.result,
      error: after.error,
      finished_at: now,
      head_sha: after.head_sha,
    })
    .where("id", "=", runId)
    .where("status", "=", "claimed")
    .where("fencing_token", "=", fencingToken);
  if (lapsedBefore !== undefined) finish = finish.where("lease_expires_at", "<", lapsedBefore);
  const agent: Actor = { kind: "agent", id: run.agent_id };
  const summary = ended.status === "done" ? ended.result.summary.trim() : "";
  const stopWith = ended.status === "done" ? ended.stopWith : undefined;
  const stepped = await advance(
    d1,
    itemId,
    // The event and the summary carry the run's id, so the timeline can link them to it.
    ended.status === "failed"
      ? { type: "run.failed", stay: run.stay, error: ended.error, runId }
      : stopWith !== undefined
        ? { type: "run.failed", stay: run.stay, error: stopWith, runId }
        : { type: "run.ended", stay: run.stay, outcome: ended.result.outcome, runId },
    agent,
    {
      before: [toStatement(d1, finish), guardChanged(d1, "flow_runs.fencing_token")],
      ...(summary ? { comment: { actor: agent, text: summary, runId } } : {}),
      ...(ended.status === "done" && pushed?.headSha ? { headSha: pushed.headSha } : {}),
    },
  );
  return { ...stepped, run: toRun(after) };
}

/** The agent finished: the item moves on (or back). A stale fencing token is refused. */
export async function finishRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  result: RunResult,
): Promise<Item> {
  return (await endRun(d1, runId, fencingToken, { status: "done", result })).item;
}

/** The run failed: the item stops with the error until someone retries it. */
export async function failRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  error: string,
): Promise<Item> {
  return (await endRun(d1, runId, fencingToken, { status: "failed", error })).item;
}

/**
 * Fails one claimed run as the lease sweep does: only if, at write time, it still holds
 * `fencingToken` and its lease lapsed before `now`. Null when it ended, was claimed again, or its
 * runner renewed the lease after the sweep read it.
 */
export async function expireRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  now: number,
): Promise<EndedRun | null> {
  try {
    return await endRun(
      d1,
      runId,
      fencingToken,
      { status: "failed", error: STOPPED_RESPONDING },
      iso(now),
    );
  } catch (error) {
    if (error instanceof StoreError) return null;
    throw error;
  }
}

/**
 * Fails claimed runs whose lease lapsed before `now`, oldest first, through expireRun. Reads
 * flow_runs_lease_idx. At most 10 a call (AGENTS.md cost rule 8: each one is a few queries); a run
 * that ended or was renewed meanwhile is skipped. `onEnded` runs after each item's run that failed
 * (the plugin hooks); a chat's run gets the agent's note that it stopped instead. Returns how many it
 * failed.
 */
export async function expireRuns(
  d1: D1Database,
  now: number,
  limit: number,
  onEnded?: (ended: EndedRun) => Promise<void>,
): Promise<number> {
  const lapsed = await flowDb(d1)
    .selectFrom("flow_runs")
    .select(["id", "fencing_token", "chat_id"])
    .where("status", "=", sql.lit("claimed"))
    .where("lease_expires_at", "<", iso(now))
    .orderBy("lease_expires_at")
    .limit(Math.min(limit, 10))
    .execute();
  let failed = 0;
  for (const run of lapsed) {
    if (run.chat_id !== null) {
      if (await expireChatRun(d1, run.id, run.fencing_token, now, STOPPED_RESPONDING)) failed++;
      continue;
    }
    const ended = await expireRun(d1, run.id, run.fencing_token, now);
    if (!ended) continue;
    failed++;
    await onEnded?.(ended);
  }
  return failed;
}

/** Stores the hash of a claimed run's MCP bearer token. */
export async function setMcpTokenHash(d1: D1Database, runId: string, hash: string): Promise<void> {
  await flowDb(d1)
    .updateTable("flow_runs")
    .set({ mcp_token_hash: hash })
    .where("id", "=", runId)
    .execute();
}

/**
 * What the MCP server needs to authenticate a run's token: the run, its token's hash, and who
 * created its item or chat (the person the agent acts for). One read by primary key.
 */
export async function runForToken(
  d1: D1Database,
  runId: string,
): Promise<{ run: Run; tokenHash: string | null; createdBy: string } | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_runs as r")
    .leftJoin("flow_items as i", "i.id", "r.item_id")
    .leftJoin("flow_chats as c", "c.id", "r.chat_id")
    .selectAll("r")
    .select(["i.created_by as item_created_by", "c.created_by as chat_created_by"])
    .where("r.id", "=", runId)
    .executeTakeFirst();
  if (!row) return null;
  const { item_created_by, chat_created_by, ...run } = row;
  const createdBy = item_created_by ?? chat_created_by;
  if (createdBy === null) return null;
  return { run: toRun(run), tokenHash: run.mcp_token_hash, createdBy };
}
