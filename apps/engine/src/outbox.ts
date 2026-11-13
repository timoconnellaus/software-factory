// Outbox delivery (ADR 0012; CRM ADR 0171): rows are written in an operation's batch, delivered
// right after commit, and retried by the minute cron with backoff. Delivery is at least once;
// Workflow ids and one-shot event types make a second delivery harmless.
import { BABYSITTER, invoke, type OutboxMessage } from "@software-factory/core";
import { clientHub } from "./client-hub.ts";
import { deliverRepository } from "./deliver/deliverer.ts";
import { invokeDeps } from "./deps.ts";
import { planningHub } from "./planning-hub.ts";
import { failDeadRelease, pullProject } from "./pull.ts";

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
      // An event for a finished or unknown instance has nobody to wake: drop it. Except a shaped
      // item's release (ADR 0493): the pull already counted it running, so with no Workflow to
      // deliver it, it would hold a slot for ever. Fail it, visibly, instead.
      if (!found || FINISHED.has(found.status)) {
        if (message.payload.type.startsWith("release-")) {
          // The item is named by the event (`release-<item>`): its instance may be a later one,
          // after it was shaped again (spec 52, Q4).
          await failDeadRelease(
            env,
            message.payload.type.slice("release-".length),
            found?.status ?? "missing",
          );
        }
        return;
      }
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
    case "delivery.wake":
      // The babysitter's deliverer for that repository queue (spec 53, ADR 0580). A pass already
      // running there is told to go round again instead.
      // An item with no repository is never the babysitter's (one lease per repository, ADR 0586).
      if (message.payload.repositoryId) {
        await deliverRepository(env, message.payload.projectId, message.payload.repositoryId);
      }
      return;
    case "verify.recheck":
      // A red episode opened or closed (spec 53, decision 7): `factory/verify` on this head is
      // evaluated again, so "held: main is red" goes on or comes off. As the babysitter.
      await invoke(
        invokeDeps(env),
        "verify.refresh",
        { ...message.payload, trigger: "rerequested" },
        { actor: BABYSITTER, origin: { surface: "cron", step: "verify.recheck" } },
      );
      return;
    case "queue.pull":
      // The pull a release, finish or cancel asked for, now that it has committed (ADR 0491).
      await pullProject(env, message.payload.projectId);
      return;
    case "planning.changed":
      // Live Planning tabs and the planning agent's held wait hear it from the hub (ADR 0350).
      await planningHub(env, message.payload.workItemId).notify();
      await notifyPlanningViewers(env, message.payload.workItemId);
      return;
    case "run.steered":
      // Nothing to wake: the runner host's held steer call polls for queued steers in the Worker
      // (spec 44 part A); the runner socket's push (part B) will route here by job.
      return;
    case "device.revoked":
      // A revoked device's live socket closes now, not when it next calls (ADR 0541).
      await clientHub(env, message.payload.userId).closeDevice(message.payload.deviceId);
      return;
    case "notify":
      // To the person's open desktop apps (spec 40 M2b). Web push arrives with spec 15; the inbox
      // itself always reads gates and questions from D1.
      await notifyClients(env, message.payload);
      return;
  }
}

/** Who has a Planning view open: a heartbeat within this long (core's PRESENCE_TTL_MS). */
const PLANNING_VIEWER_MS = 60_000;

/**
 * Tells the desktop apps of everyone with this work item's Planning view open that it changed (spec
 * 26), so the desktop re-reads instead of polling; sf-app hears it from the PlanningHub's stream.
 */
export async function notifyPlanningViewers(env: Env, workItemId: string): Promise<string[]> {
  const since = new Date(Date.now() - PLANNING_VIEWER_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM core_planning_presence WHERE work_item_id = ? AND seen_at > ? AND left_at IS NULL",
  )
    .bind(workItemId, since)
    .all<{ user_id: string }>();
  const users = results.map((r) => r.user_id);
  await Promise.all(
    users.map((u) => clientHub(env, u).broadcast({ type: "planning.changed", workItemId })),
  );
  return users;
}

type NotifyPayload = Extract<OutboxMessage, { kind: "notify" }>["payload"];

/**
 * Who hears a notification: its person, or, when it names nobody, the admins of the work item's
 * org (the approvers a gate falls to when the policy names none). Returns the people pushed to.
 */
export async function notifyClients(env: Env, payload: NotifyPayload): Promise<string[]> {
  let users: string[] = payload.userId ? [payload.userId] : [];
  if (users.length === 0 && payload.workItemId) {
    const { results } = await env.DB.prepare(
      `SELECT m.user_id FROM core_member m JOIN core_work_items w ON w.org_id = m.organization_id
       WHERE w.id = ? AND m.role IN ('owner', 'admin')`,
    )
      .bind(payload.workItemId)
      .all<{ user_id: string }>();
    users = results.map((r) => r.user_id);
  }
  await Promise.all(
    users.map((u) =>
      clientHub(env, u).broadcast({
        type: "notify",
        event: payload.event,
        title: payload.title,
        workItemId: payload.workItemId ?? null,
      }),
    ),
  );
  return users;
}
