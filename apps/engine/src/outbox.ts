// Outbox delivery (ADR 0012; CRM ADR 0171): rows are written in an operation's batch, delivered
// right after commit, and retried by the minute cron with backoff. Delivery is at least once;
// Workflow ids and one-shot event types make a second delivery harmless.
import type { OutboxMessage } from "@software-factory/core";
import { planningHub } from "./planning-hub.ts";

interface OutboxRow {
  id: string;
  kind: OutboxMessage["kind"];
  payload: string;
  attempts: number;
}

const MAX_BACKOFF_MS = 60 * 60_000;
const FINISHED = new Set(["complete", "errored", "terminated"]);

export async function deliverOutbox(env: Env, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { results } = await env.DB.prepare(
    "SELECT id, kind, payload, attempts FROM core_outbox WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(ids))
    .all<OutboxRow>();
  for (const row of results) await deliverRow(env, row);
}

/** The cron's pass: up to 50 due rows, oldest first. */
export async function retryOutbox(env: Env, now = new Date()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, payload, attempts FROM core_outbox WHERE next_at <= ? ORDER BY at LIMIT 50",
  )
    .bind(now.toISOString())
    .all<OutboxRow>();
  for (const row of results) await deliverRow(env, row, now);
  return results.length;
}

async function deliverRow(env: Env, row: OutboxRow, now = new Date()): Promise<void> {
  try {
    await dispatch(env, { kind: row.kind, payload: JSON.parse(row.payload) } as OutboxMessage);
    await env.DB.prepare("DELETE FROM core_outbox WHERE id = ?").bind(row.id).run();
  } catch (error) {
    const attempts = row.attempts + 1;
    const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (attempts - 1));
    console.error(`outbox ${row.id} (${row.kind}) failed, attempt ${attempts}`, error);
    await env.DB.prepare(
      "UPDATE core_outbox SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?",
    )
      .bind(attempts, String(error), new Date(now.getTime() + backoff).toISOString(), row.id)
      .run();
  }
}

async function instanceStatus(env: Env, id: string) {
  try {
    const instance = await env.WORK_ITEM_WORKFLOW.get(id);
    return { instance, status: (await instance.status()).status as string };
  } catch (error) {
    if (/not.?found/i.test(String(error))) return null;
    throw error;
  }
}

async function dispatch(env: Env, message: OutboxMessage): Promise<void> {
  switch (message.kind) {
    case "workflow.create": {
      try {
        await env.WORK_ITEM_WORKFLOW.create({
          id: message.payload.instanceId,
          params: message.payload.params,
        });
      } catch (error) {
        // The instance id is the work item id: an existing instance means it already started.
        if (!/already exists/i.test(String(error))) throw error;
      }
      return;
    }
    case "workflow.event": {
      const found = await instanceStatus(env, message.payload.instanceId);
      // An event for a finished or unknown instance has nobody to wake: drop it.
      if (!found || FINISHED.has(found.status)) return;
      await found.instance.sendEvent({
        type: message.payload.type,
        payload: message.payload.payload,
      });
      return;
    }
    case "workflow.pause": {
      const found = await instanceStatus(env, message.payload.instanceId);
      if (found && ["running", "waiting", "queued"].includes(found.status))
        await found.instance.pause();
      return;
    }
    case "workflow.resume": {
      const found = await instanceStatus(env, message.payload.instanceId);
      if (!found || FINISHED.has(found.status)) return;
      if (found.status === "paused" || found.status === "waitingForPause")
        await found.instance.resume();
      for (const type of message.payload.events)
        await found.instance.sendEvent({ type, payload: {} });
      return;
    }
    case "workflow.terminate": {
      const found = await instanceStatus(env, message.payload.instanceId);
      if (found && !FINISHED.has(found.status)) await found.instance.terminate();
      return;
    }
    case "planning.changed":
      // Live Planning tabs and the planning agent's held wait hear it from the hub (ADR 0340).
      await planningHub(env, message.payload.workItemId).notify();
      return;
    case "notify":
      // Web push arrives with spec 15; until then the inbox reads gates and questions from D1.
      console.log("notify", JSON.stringify(message.payload));
      return;
  }
}
