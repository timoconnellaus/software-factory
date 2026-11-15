// A chat's run ends (migration 0433): the runner's hand-back, its failure, or the lease sweep. There
// is no item to step: the run is marked, and the model's reply (its summary, or a plain note that it
// failed) is added to the chat, in one batch (stored with role `agent`, which the API calls
// `assistant`). The person can simply send again after a failure.
import { guardChanged } from "@software-factory/db";
import { appendMessage, chatBatch } from "./chats.ts";
import { flowDb, iso, StoreError } from "./db.ts";
import { type Run, type RunResult, toRun } from "./run-row.ts";
import type { FlowRunRow } from "./schema.ts";

/** How a chat's run ended. */
export type ChatRunEnding =
  | { status: "done"; result: RunResult }
  | { status: "failed"; error: string };

/** The model's reply for a run that failed: plain, with the error, and what to do next. */
export function failedReply(error: string): string {
  const said = error.trim() || "The run failed.";
  return `I couldn't finish that: ${said}${/[.!?]$/.test(said) ? "" : "."} Send your message again to have me try once more.`;
}

/**
 * Ends a claimed chat run and adds the model's reply. With `lapsedBefore` the run's update also
 * requires its lease to have lapsed before then (the sweep). A stale fencing token, or a run that
 * ended meanwhile, is refused (`stale_run`).
 */
export async function endChatRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  ended: ChatRunEnding,
  lapsedBefore?: string,
): Promise<Run> {
  // With its chat's model (by primary key): the reply names the model that wrote it.
  const found = await flowDb(d1)
    .selectFrom("flow_runs as r")
    .leftJoin("flow_chats as c", "c.id", "r.chat_id")
    .selectAll("r")
    .select("c.model as chat_model")
    .where("r.id", "=", runId)
    .executeTakeFirst();
  if (!found) throw new StoreError("not_found", `No run ${runId}.`);
  const { chat_model: model, ...run } = found;
  const chatId = run.chat_id;
  if (chatId === null) throw new StoreError("invalid", `Run ${runId} is an item's run.`);
  const stale = new StoreError(
    "stale_run",
    `Run ${runId} is ${run.status} with fencing token ${run.fencing_token}; this call holds ${fencingToken}.`,
  );
  if (run.status !== "claimed" || run.fencing_token !== fencingToken) throw stale;
  const now = iso();
  const after: FlowRunRow = {
    ...run,
    status: ended.status,
    result: ended.status === "done" ? JSON.stringify(ended.result) : null,
    error: ended.status === "failed" ? ended.error : null,
    finished_at: now,
  };
  // `model`: the alias the run used (null: the runner's default), so the app can label the reply.
  const reply =
    ended.status === "done"
      ? { text: ended.result.summary.trim() || "Done.", data: { model } }
      : { text: failedReply(ended.error), data: { failed: true, error: ended.error, model } };
  const lapsed = lapsedBefore !== undefined ? " AND lease_expires_at < ?" : "";
  await chatBatch(
    d1,
    () => [
      d1
        .prepare(
          `UPDATE flow_runs SET status = ?, result = ?, error = ?, finished_at = ?
            WHERE id = ? AND status = 'claimed' AND fencing_token = ?${lapsed}`,
        )
        .bind(
          after.status,
          after.result,
          after.error,
          now,
          runId,
          fencingToken,
          ...(lapsedBefore !== undefined ? [lapsedBefore] : []),
        ),
      guardChanged(d1, "flow_runs.fencing_token"),
      appendMessage(d1, {
        chatId,
        orgId: run.org_id,
        role: "agent",
        text: reply.text,
        data: reply.data,
        runId,
        at: now,
      }),
      d1.prepare("UPDATE flow_chats SET updated_at = ? WHERE id = ?").bind(now, chatId),
    ],
    stale,
  );
  return toRun(after);
}

/**
 * Fails one claimed chat run as the lease sweep does: only if it still holds `fencingToken` and its
 * lease lapsed before `now`, at write time. False when it ended, was claimed again, or was renewed.
 */
export async function expireChatRun(
  d1: D1Database,
  runId: string,
  fencingToken: number,
  now: number,
  error: string,
): Promise<boolean> {
  try {
    await endChatRun(d1, runId, fencingToken, { status: "failed", error }, iso(now));
    return true;
  } catch (e) {
    if (e instanceof StoreError) return false;
    throw e;
  }
}
