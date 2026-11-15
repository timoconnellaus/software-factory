// Outbox delivery (ADR 0012; CRM ADR 0171): rows are written in an operation's batch, delivered
// right after commit, and retried by the minute cron with backoff. Delivery is at least once, and
// both kinds are harmless to repeat: closing a revoked device's sockets, and a notification.
import type { OutboxMessage } from "@software-factory/core";
import { clientHub } from "./client-hub.ts";

interface OutboxRow {
  id: string;
  kind: OutboxMessage["kind"];
  payload: string;
  attempts: number;
}

const MAX_BACKOFF_MS = 60 * 60_000;

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

async function dispatch(env: Env, message: OutboxMessage): Promise<void> {
  switch (message.kind) {
    case "device.revoked":
      // A revoked device's live socket closes now, not when it next calls (ADR 0541).
      await clientHub(env, message.payload.userId).closeDevice(message.payload.deviceId);
      return;
    case "notify":
      // To the person's open desktop apps (spec 40 M2b).
      await notifyClients(env, message.payload);
      return;
  }
}

type NotifyPayload = Extract<OutboxMessage, { kind: "notify" }>["payload"];

/** Pushes a notification to its person's open desktop apps. Returns the people pushed to. */
export async function notifyClients(env: Env, payload: NotifyPayload): Promise<string[]> {
  const users = payload.userId ? [payload.userId] : [];
  await Promise.all(
    users.map((u) =>
      clientHub(env, u).broadcast({ type: "notify", event: payload.event, title: payload.title }),
    ),
  );
  return users;
}
