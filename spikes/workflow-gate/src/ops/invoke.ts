// The single invocation pipeline (CRM ADR 0018):
//   idempotency → validate → actor check → kill switch → gate → handler → output check →
//   ONE D1 batch with the handler's writes + the audit row + the outbox rows → deliver outbox.
// A `review` decision does not run the handler: it records a pending action (in one batch with
// its audit and notify rows) and returns `pending`. The approved re-run passes `approvalId`.
import type { Actor, HandlerContext, Origin, OutboxMessage, PendingActionRow } from "./define";
import { getOperation } from "./define";
import { OperationError } from "./errors";
import { type Decision, decide, parseFloor, parsePreset, type RiskClass } from "./gate";
import { deliverOutbox, outboxNextAt } from "./outbox";

export interface InvokeOptions {
  actor: Actor;
  origin: Origin;
  /** A retried call with the same key returns the first call's outcome instead of running again. */
  idempotencyKey?: string;
  /** The approved pending action this call carries out. */
  approvalId?: string;
}

export type InvokeResult =
  | { status: "ok"; output: unknown; auditId: string }
  | { status: "pending"; pendingActionId: string; auditId: string };

type Outcome = "ok" | "review" | "denied" | "forbidden" | "killed" | "failed";

interface AuditFields {
  operation: string;
  risk: RiskClass;
  decision: Decision | "n/a";
  outcome: Outcome;
  reason?: string;
  input: unknown;
  result?: unknown;
  workItemId?: string | null;
  pendingActionId?: string;
  approvalId?: string | undefined;
  auditId?: string;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function invoke(
  env: Env,
  name: string,
  rawInput: unknown,
  options: InvokeOptions,
): Promise<InvokeResult> {
  const op = getOperation(name);
  if (!op) throw new OperationError("unknown_operation", `unknown operation ${name}`);
  const { actor, origin, idempotencyKey, approvalId } = options;
  const db = env.DB;
  const now = new Date().toISOString();

  const audit = (fields: AuditFields) =>
    auditStatement(db, now, actor, origin, idempotencyKey, fields);
  const refuse = async (fields: AuditFields, error: OperationError): Promise<never> => {
    await audit(fields).run();
    throw error;
  };

  // 1. Idempotency: a retried Workflow step must not apply a write (or open a gate) twice.
  if (idempotencyKey) {
    const prior = await db
      .prepare(
        `SELECT id, outcome, result, pending_action_id, reason FROM audit WHERE idempotency_key = ?`,
      )
      .bind(idempotencyKey)
      .first<{
        id: string;
        outcome: Outcome;
        result: string | null;
        pending_action_id: string | null;
        reason: string | null;
      }>();
    if (prior?.outcome === "ok") {
      return {
        status: "ok",
        output: prior.result ? JSON.parse(prior.result) : null,
        auditId: prior.id,
      };
    }
    if (prior?.outcome === "review" && prior.pending_action_id) {
      return { status: "pending", pendingActionId: prior.pending_action_id, auditId: prior.id };
    }
    if (prior && prior.outcome !== "failed") {
      throw new OperationError(
        prior.outcome === "killed" ? "killed" : "denied",
        prior.reason ?? prior.outcome,
        prior.result ? JSON.parse(prior.result) : undefined,
      );
    }
  }

  // 2. Validate. Malformed calls change nothing and are not audited.
  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new OperationError("invalid_input", `invalid input for ${name}`, parsed.error.issues);
  }
  const input = parsed.data as Record<string, unknown>;
  const inputWorkItem = typeof input.workItemId === "string" ? input.workItemId : null;
  const base = { operation: name, risk: op.risk, input, workItemId: inputWorkItem, approvalId };

  // 3. Actor check.
  if (op.actors && !op.actors.includes(actor.type)) {
    return refuse(
      {
        ...base,
        decision: "n/a",
        outcome: "forbidden",
        reason: `actor ${actor.type} may not call ${name}`,
      },
      new OperationError("forbidden", `${actor.type} may not call ${name}`),
    );
  }

  // 4. Policy: preset (D1) + floor (env) + kill switch, read once.
  const settings = await readSettings(db);
  if (settings.killSwitch && actor.type !== "human" && op.risk !== "read") {
    return refuse(
      {
        ...base,
        decision: "n/a",
        outcome: "killed",
        reason: "kill switch is on",
        result: { killEpoch: settings.killEpoch },
      },
      new OperationError("killed", "the kill switch is on", { killEpoch: settings.killEpoch }),
    );
  }
  const gate = decide({
    actor: actor.type,
    risk: op.risk,
    preset: settings.preset,
    floor: parseFloor(env.APPROVAL_FLOOR),
  });

  // 5. An approved re-run must match its pending action. `deny` still refuses it.
  let approval: PendingActionRow | undefined;
  if (approvalId) {
    approval =
      (await db
        .prepare(`SELECT * FROM pending_actions WHERE id = ?`)
        .bind(approvalId)
        .first<PendingActionRow>()) ?? undefined;
    if (
      approval?.status !== "approved" ||
      approval.operation !== name ||
      approval.actor_type !== actor.type ||
      approval.work_item_id !== inputWorkItem
    ) {
      return refuse(
        {
          ...base,
          decision: gate.decision,
          outcome: "denied",
          reason: "approval does not match an approved action",
        },
        new OperationError("bad_approval", "approval does not match an approved action"),
      );
    }
  }

  if (gate.decision === "deny") {
    return refuse(
      { ...base, decision: "deny", outcome: "denied", reason: gate.reason },
      new OperationError("denied", `${name} denied for ${actor.type}: ${gate.reason}`),
    );
  }

  // 6. Review: record a pending action instead of running the handler.
  if (gate.decision === "review" && !approval) {
    const pendingActionId = newId("pa");
    const notify: OutboxMessage = {
      kind: "notify",
      payload: { event: "approval.pending", pendingActionId, operation: name },
    };
    const outboxId = newId("ob");
    const auditId = newId("au");
    await db.batch([
      db
        .prepare(
          `INSERT INTO pending_actions (id, operation, risk, actor_type, actor_id, input, work_item_id, workflow_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          pendingActionId,
          name,
          op.risk,
          actor.type,
          actor.id,
          JSON.stringify(input),
          inputWorkItem,
          origin.workflowId ?? null,
          now,
        ),
      audit({
        ...base,
        decision: "review",
        outcome: "review",
        reason: gate.reason,
        pendingActionId,
        auditId,
      }),
      outboxStatement(db, now, outboxId, notify),
    ]);
    await deliverOutbox(env, [outboxId]);
    return { status: "pending", pendingActionId, auditId };
  }

  // 7. Run the handler: it reads now and queues its writes.
  const writes: D1PreparedStatement[] = [];
  const messages: OutboxMessage[] = [];
  let subject = inputWorkItem;
  const ctx: HandlerContext = {
    env,
    db,
    actor,
    origin,
    now,
    write: (statement) => writes.push(statement),
    emit: (message) => messages.push(message),
    subject: (workItemId) => {
      subject = workItemId;
    },
    ...(approval ? { approval } : {}),
  };

  let output: unknown;
  try {
    output = op.output.parse(await op.handler(input, ctx));
  } catch (error) {
    await audit({
      ...base,
      decision: gate.decision,
      outcome: "failed",
      reason: String(error),
    }).run();
    throw error;
  }
  if (op.risk === "read" && (writes.length > 0 || messages.length > 0)) {
    throw new Error(`read operation ${name} queued writes`);
  }
  if (op.risk === "read") return { status: "ok", output, auditId: "" };

  // 8. One batch: writes + approval consumed + audit + outbox. All or nothing.
  const auditId = newId("au");
  const outboxIds = messages.map(() => newId("ob"));
  const statements = [
    ...writes,
    ...(approval
      ? [
          db
            .prepare(
              `UPDATE pending_actions SET status = 'applied' WHERE id = ? AND status = 'approved'`,
            )
            .bind(approval.id),
        ]
      : []),
    audit({
      ...base,
      workItemId: subject,
      decision: gate.decision,
      outcome: "ok",
      reason: approval ? `approved (${approval.id})` : gate.reason,
      result: output,
      auditId,
    }),
    ...messages.map((message, i) => outboxStatement(db, now, outboxIds[i] as string, message)),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    await audit({
      ...base,
      decision: gate.decision,
      outcome: "failed",
      reason: String(error),
    }).run();
    if (/UNIQUE constraint failed/.test(String(error))) {
      throw new OperationError("conflict", String(error));
    }
    throw error;
  }

  // 9. After commit: deliver. A failed send leaves the row for the cron; the caller still succeeds.
  await deliverOutbox(env, outboxIds);
  return { status: "ok", output, auditId };
}

interface Settings {
  preset: ReturnType<typeof parsePreset>;
  killSwitch: boolean;
  /** Bumped each time the kill switch turns on; names the event that releases parked steps. */
  killEpoch: number;
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN ('preset', 'kill_switch', 'kill_epoch')`)
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  return {
    preset: parsePreset(map.get("preset")),
    killSwitch: map.get("kill_switch") === "on",
    killEpoch: Number(map.get("kill_epoch") ?? 0),
  };
}

function auditStatement(
  db: D1Database,
  now: string,
  actor: Actor,
  origin: Origin,
  idempotencyKey: string | undefined,
  fields: AuditFields,
): D1PreparedStatement {
  // Only the outcomes that settle a call claim the idempotency key; a failure may be retried.
  const key = fields.outcome === "failed" ? null : (idempotencyKey ?? null);
  return db
    .prepare(
      `INSERT INTO audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, reason,
         input, result, work_item_id, pending_action_id, approval_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.auditId ?? newId("au"),
      now,
      fields.operation,
      fields.risk,
      actor.type,
      actor.id,
      JSON.stringify(origin),
      fields.decision,
      fields.outcome,
      fields.reason ?? null,
      JSON.stringify(fields.input ?? null),
      fields.result === undefined ? null : JSON.stringify(fields.result),
      fields.workItemId ?? null,
      fields.pendingActionId ?? null,
      fields.approvalId ?? null,
      key,
    );
}

function outboxStatement(db: D1Database, now: string, id: string, message: OutboxMessage) {
  return db
    .prepare(`INSERT INTO outbox (id, at, kind, payload, next_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, now, message.kind, JSON.stringify(message.payload), outboxNextAt(now));
}
