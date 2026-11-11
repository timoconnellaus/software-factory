// Outbox delivery (CRM ADR 0171): rows are written in the operation's batch, delivered right after
// commit, and retried by the minute cron. Delivery is at least once; Workflow ids and event types
// make a second delivery harmless.
import type { OutboxMessage } from "./define";

interface OutboxRow {
  id: string;
  kind: OutboxMessage["kind"];
  payload: string;
  attempts: number;
}

/** Grace before the cron touches a row, so it never races the post-commit send. */
const GRACE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export async function deliverOutbox(env: Env, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { results } = await env.DB.prepare(
    `SELECT id, kind, payload, attempts FROM outbox WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<OutboxRow>();
  for (const row of results) await deliverRow(env, row);
}

/** The cron's retry pass: at most 50 due rows, oldest first. */
export async function retryOutbox(env: Env, now = new Date()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, payload, attempts FROM outbox WHERE next_at <= ? ORDER BY at LIMIT 50`,
  )
    .bind(now.toISOString())
    .all<OutboxRow>();
  for (const row of results) await deliverRow(env, row, now);
  return results.length;
}

async function deliverRow(env: Env, row: OutboxRow, now = new Date()): Promise<void> {
  try {
    await dispatch(env, { kind: row.kind, payload: JSON.parse(row.payload) } as OutboxMessage);
    await env.DB.prepare(`DELETE FROM outbox WHERE id = ?`).bind(row.id).run();
  } catch (error) {
    const attempts = row.attempts + 1;
    const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (attempts - 1));
    console.error(`outbox ${row.id} (${row.kind}) failed, attempt ${attempts}`, error);
    await env.DB.prepare(`UPDATE outbox SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?`)
      .bind(attempts, String(error), new Date(now.getTime() + backoff).toISOString(), row.id)
      .run();
  }
}

export function outboxNextAt(now: string): string {
  return new Date(Date.parse(now) + GRACE_MS).toISOString();
}

async function dispatch(env: Env, message: OutboxMessage): Promise<void> {
  switch (message.kind) {
    case "workflow.create": {
      try {
        await env.WORK_ITEM_WORKFLOW.create(message.payload);
      } catch (error) {
        // The id is derived from the intake event: an existing instance means it already started.
        if (!/already exists/i.test(String(error))) throw error;
      }
      return;
    }
    case "workflow.event": {
      const instance = await env.WORK_ITEM_WORKFLOW.get(message.payload.instanceId);
      await instance.sendEvent({ type: message.payload.type, payload: message.payload.payload });
      return;
    }
    case "workflow.pause": {
      const instance = await env.WORK_ITEM_WORKFLOW.get(message.payload.instanceId);
      const { status } = await instance.status();
      if (status === "running" || status === "waiting" || status === "queued")
        await instance.pause();
      return;
    }
    case "workflow.resume": {
      const instance = await env.WORK_ITEM_WORKFLOW.get(message.payload.instanceId);
      const { status } = await instance.status();
      if (status === "paused" || status === "waitingForPause") await instance.resume();
      // Releases a step that the kill switch refused mid-flight (it parks on this event). The
      // epoch in the type means a stale event can never release a later park.
      if (status !== "complete" && status !== "errored" && status !== "terminated") {
        await instance.sendEvent({
          type: `factory-resume-${message.payload.killEpoch}`,
          payload: {},
        });
      }
      return;
    }
    case "notify":
      // No push channel in the spike; the inbox reads pending actions from D1.
      console.log("notify", JSON.stringify(message.payload));
      return;
  }
}
