// The single invocation pipeline (ADR 0004, spec 01):
//
//   idempotency → validate → scope → actor check → browser-only / presence → permission →
//   handler → output check → ONE D1 batch: the handler's writes and guards + the audit row + the
//   outbox rows → deliver.
import {
  clearGuards,
  createDb,
  failedGuard,
  guardChanged,
  toStatement,
} from "@software-factory/db";
import type { Compilable } from "kysely";
import { type Actor, type DeviceSurface, isDeviceSurface, type Origin } from "./actors.ts";
import { OperationError } from "./errors.ts";
import { newId } from "./ids.ts";
import type {
  AnyOperation,
  Change,
  HandlerContext,
  OutboxMessage,
  RiskClass,
  Scope,
} from "./operation.ts";
import { getOperation } from "./registry.ts";
import { checkPermission, defaultScopeRef, resolveScope } from "./scope.ts";
import type { FactoryServices } from "./services.ts";

export interface InvokeDeps {
  d1: D1Database;
  services: FactoryServices;
  /** Delivers outbox rows right after commit. Failures are left for the cron. */
  deliver?: (outboxIds: string[]) => Promise<void>;
  now?: () => Date;
  /**
   * Test seam only: called after an operation's reads and before its batch commits, so a test can
   * hold one call there while another runs (deterministic races, spec 26).
   */
  beforeCommit?: (operation: string) => Promise<void>;
}

export interface InvokeOptions {
  actor: Actor;
  origin: Origin;
  /** A retried call with the same key returns the first call's outcome instead of running again. */
  idempotencyKey?: string;
}

export type InvokeResult<O = unknown> = { status: "ok"; output: O; auditId: string | null };

type Outcome = "ok" | "forbidden" | "failed";

interface AuditFields {
  outcome: Outcome;
  reason?: string | undefined;
  result?: unknown;
  diff?: Change[];
  auditId?: string;
}

/** Outbox rows wait this long before the cron retries them, so it never races the first send. */
export const OUTBOX_GRACE_MS = 60_000;

export async function invoke<O = unknown>(
  deps: InvokeDeps,
  name: string,
  rawInput: unknown,
  options: InvokeOptions,
): Promise<InvokeResult<O>> {
  const op = getOperation(name);
  if (!op) throw new OperationError("unknown_operation", `unknown operation ${name}`);
  return runOperation<O>(deps, op, rawInput, options);
}

/** The SHA-256 (hex) of an input's canonical JSON: what a presence proof is bound to (ADR 0391). */
export async function inputDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input ?? {}));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level and `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Whether a device surface's presence proof may be taken for `op` (ADR 0391, 0541). */
export function presenceSurfaceAllowed(op: AnyOperation, surface: DeviceSurface): boolean {
  return (op.presenceSurfaces ?? []).includes(surface);
}

async function presenceAllows(op: AnyOperation, origin: Origin, rawInput: unknown) {
  if (!isDeviceSurface(origin.surface) || !origin.presence) return false;
  if (!presenceSurfaceAllowed(op, origin.surface)) return false;
  if (origin.presence.op !== op.name) return false;
  return origin.presence.inputDigest === (await inputDigest(rawInput));
}

export async function runOperation<O = unknown>(
  deps: InvokeDeps,
  op: AnyOperation,
  rawInput: unknown,
  options: InvokeOptions,
): Promise<InvokeResult<O>> {
  const { actor, origin, idempotencyKey } = options;
  const d1 = deps.d1;
  const db = createDb(d1);
  const now = (deps.now?.() ?? new Date()).toISOString();

  // 1. Idempotency: a retried call must not apply a write twice.
  if (idempotencyKey) {
    const prior = await db
      .selectFrom("core_audit")
      .select(["id", "outcome", "result", "reason"])
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (prior?.outcome === "ok") {
      return { status: "ok", output: parse(prior.result) as O, auditId: prior.id };
    }
    if (prior && prior.outcome !== "failed") {
      const details = parse(prior.result) as Record<string, unknown> | null;
      throw new OperationError("forbidden", prior.reason ?? prior.outcome, details ?? undefined);
    }
  }

  // 2. Validate. Malformed calls change nothing and are not audited.
  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new OperationError("invalid_input", `invalid input for ${op.name}`, {
      issues: parsed.error.issues,
    });
  }
  const input = parsed.data as Record<string, unknown>;
  const risk: RiskClass = op.risk;
  const redacted = op.redact?.input ? op.redact.input(input) : input;
  // A runner's input is machine chatter (manifests, capacity): the audit keeps its digest and the
  // ids a reader follows, not the body (ADR 0590).
  const redactedInput = actor.type === "runner" ? await auditDigest(redacted) : redacted;

  // 3. Scope: the org this call is about.
  const scope: Scope = resolveScope(defaultScopeRef(input));
  const audit = (fields: AuditFields, subject: Partial<Scope> = scope) =>
    auditStatement(d1, {
      now,
      actor,
      origin,
      idempotencyKey,
      operation: op.name,
      risk,
      input: redactedInput,
      orgId: subject.orgId ?? null,
      ...fields,
    });
  const refuse = async (fields: AuditFields, error: OperationError): Promise<never> => {
    await audit({ ...fields, result: error.details }).run();
    throw error;
  };

  // 4. Actor check.
  if (!op.actors.includes(actor.type)) {
    return refuse(
      { outcome: "forbidden", reason: `actor ${actor.type} may not call ${op.name}` },
      new OperationError("forbidden", `${actor.type} may not call ${op.name}`),
    );
  }

  // 5. Browser-only decisions (ADR 0340): a person approves a device or registers a runner on the
  //    website, never through a token another surface holds (the CLI), which an agent session
  //    might be using.
  if (
    actor.type === "human" &&
    origin.surface !== "app" &&
    origin.surface !== "test" &&
    op.browserOnly &&
    !(await presenceAllows(op, origin, rawInput))
  ) {
    return refuse(
      { outcome: "forbidden", reason: `${op.name} is browser-only (surface ${origin.surface})` },
      new OperationError(
        "forbidden",
        `${op.name} is a decision you make in the app, not from ${origin.surface} (ADR 0340)`,
        { browserOnly: true },
      ),
    );
  }

  // 6. Permission (humans).
  try {
    await checkPermission(db, actor, op.permission, scope);
  } catch (error) {
    if (error instanceof OperationError) {
      return refuse({ outcome: "forbidden", reason: error.message }, error);
    }
    throw error;
  }

  // 7. Run the handler: it reads now and queues its writes.
  const statements: D1PreparedStatement[] = [];
  const messages: OutboxMessage[] = [];
  const changes: Change[] = [];
  let changed = false;
  let subject: Partial<Scope> = { ...scope };
  const presence = origin.presence ? await presenceAllows(op, origin, rawInput) : false;
  const ctx: HandlerContext = {
    db,
    d1,
    actor,
    origin,
    presence,
    now,
    services: deps.services,
    scope,
    write: (statement) => {
      statements.push(isPrepared(statement) ? statement : toStatement(d1, statement));
    },
    guardChanged: (guardName) => statements.push(guardChanged(d1, `${op.name}:${guardName}`)),
    guardExists: (guardName, query: Compilable) => {
      const { sql, parameters } = query.compile();
      statements.push(
        d1
          .prepare(`INSERT INTO core_batch_guard (name, ok) SELECT ?, EXISTS (${sql})`)
          .bind(`${op.name}:${guardName}`, ...parameters),
      );
    },
    emit: (message) => messages.push(message),
    change: (c) => changes.push(c),
    changed: () => {
      changed = true;
    },
    subject: (ref) => {
      subject = { ...subject, ...(ref.orgId ? { orgId: ref.orgId } : {}) };
    },
  };

  let output: unknown;
  try {
    output = op.output.parse(await op.handler(input, ctx));
  } catch (error) {
    await audit({ outcome: "failed", reason: String(error) }, subject).run();
    throw error;
  }
  if (risk === "read") {
    if (statements.length > 0 || messages.length > 0) {
      throw new Error(`read operation ${op.name} queued writes`);
    }
    return { status: "ok", output: output as O, auditId: null };
  }

  // 8. One batch: writes + guards + audit + outbox. All or nothing. A changes-only operation that
  //    changed nothing writes no audit row (ADR 0590).
  const audited =
    !op.audit?.changesOnly ||
    idempotencyKey !== undefined ||
    changed ||
    changes.length > 0 ||
    messages.length > 0 ||
    op.audit.changed?.(output) === true;
  const auditId = audited ? newId("audit") : null;
  // Nothing to write and nothing to audit: no batch at all.
  if (!auditId && statements.length === 0 && messages.length === 0) {
    return { status: "ok", output: output as O, auditId: null };
  }
  const outboxIds = messages.map(() => newId("outbox"));
  // A desktop's or phone's call holds only while the device does: removing it while a call is on
  // its way refuses the call, in the same batch that would apply it (review of spec 60 PR 1a).
  // First, so it reads the device as it was before this call's own writes.
  const deviceGuard =
    actor.type === "human" && isDeviceSurface(origin.surface) && origin.deviceId
      ? origin.deviceId
      : null;
  const batch = [
    ...(deviceGuard
      ? [
          d1
            .prepare(
              "INSERT INTO core_batch_guard (name, ok) SELECT 'device', EXISTS (SELECT 1 FROM core_desktop_devices WHERE id = ? AND revoked_at IS NULL)",
            )
            .bind(deviceGuard),
        ]
      : []),
    ...statements,
    ...(auditId
      ? [
          audit(
            {
              outcome: "ok",
              result: op.redact?.output ? op.redact.output(output) : output,
              diff: changes,
              auditId,
            },
            subject,
          ),
        ]
      : []),
    ...messages.map((message, i) => outboxStatement(d1, now, outboxIds[i] as string, message)),
    clearGuards(d1),
  ];
  try {
    await deps.beforeCommit?.(op.name);
    await d1.batch(batch);
  } catch (error) {
    const guard = failedGuard(error);
    const unique = /UNIQUE constraint failed/.test(String(error));
    // A machine-frequency call (`changesOnly`, ADR 0590) that lost a race to another wrote nothing:
    // no failed row for it. Every race of any other operation is still journaled.
    if (!((guard || unique) && op.audit?.changesOnly === true)) {
      await audit(
        {
          outcome: "failed",
          reason: guard
            ? `conflict: a guarded write found the state changed (${String(error)})`
            : String(error),
        },
        subject,
      ).run();
    }
    if (guard && deviceGuard) {
      const device = await db
        .selectFrom("core_desktop_devices")
        .select("revoked_at")
        .where("id", "=", deviceGuard)
        .executeTakeFirst();
      if (!device || device.revoked_at) {
        throw new OperationError("forbidden", "this device was removed: nothing was changed", {
          deviceRemoved: true,
        });
      }
    }
    if (guard || unique) {
      // `raced`: another call changed the state between this one's reads and its batch (a guard or
      // a unique key), so trying again may succeed; not a refusal of the state as it is.
      throw new OperationError("conflict", `${op.name}: the state changed underneath this call`, {
        raced: true,
      });
    }
    throw error;
  }

  // 9. After commit: deliver. A failed send leaves the row for the cron; the caller still succeeds.
  if (deps.deliver && outboxIds.length > 0) {
    try {
      await deps.deliver(outboxIds);
    } catch (error) {
      console.error(`outbox delivery after ${op.name} failed; the cron will retry`, error);
    }
  }
  return { status: "ok", output: output as O, auditId };
}

function auditStatement(
  d1: D1Database,
  fields: AuditFields & {
    now: string;
    actor: Actor;
    origin: Origin;
    idempotencyKey: string | undefined;
    operation: string;
    risk: RiskClass;
    input: unknown;
    orgId: string | null;
  },
): D1PreparedStatement {
  // Only outcomes that settle a call claim the idempotency key; a failure may be retried.
  const key = fields.outcome === "failed" ? null : (fields.idempotencyKey ?? null);
  // `decision`: `allow` for a call that ran, `n/a` for one the checks refused or that failed (there
  // is no autonomy gate any more, so nothing is held for review).
  return d1
    .prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, reason,
         org_id, input, result, diff, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.auditId ?? newId("audit"),
      fields.now,
      fields.operation,
      fields.risk,
      fields.actor.type,
      fields.actor.id,
      JSON.stringify(fields.origin),
      fields.outcome === "ok" ? "allow" : "n/a",
      fields.outcome,
      fields.reason ?? null,
      fields.orgId,
      JSON.stringify(fields.input ?? null),
      fields.result === undefined ? null : JSON.stringify(fields.result),
      JSON.stringify(fields.diff ?? []),
      key,
    );
}

export function outboxStatement(
  d1: D1Database,
  now: string,
  id: string,
  message: OutboxMessage,
): D1PreparedStatement {
  return d1
    .prepare("INSERT INTO core_outbox (id, at, kind, payload, next_at) VALUES (?, ?, ?, ?, ?)")
    .bind(
      id,
      now,
      message.kind,
      JSON.stringify(message.payload),
      new Date(Date.parse(now) + OUTBOX_GRACE_MS).toISOString(),
    );
}

function isPrepared(value: Compilable | D1PreparedStatement): value is D1PreparedStatement {
  return typeof (value as D1PreparedStatement).bind === "function";
}

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The fields of a runner's input the audit keeps beside the digest: what a reader follows. */
const DIGEST_KEEPS = ["jobId", "claimId"] as const;

/** What the audit keeps of a runner's input (ADR 0590): its digest and size, and the ids a reader follows. */
export async function auditDigest(input: unknown): Promise<Record<string, unknown>> {
  const kept: Record<string, unknown> = {};
  if (input && typeof input === "object") {
    for (const k of DIGEST_KEEPS) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) kept[k] = v;
    }
  }
  return {
    sha256: await inputDigest(input),
    bytes: new TextEncoder().encode(canonicalJson(input ?? {})).length,
    ...kept,
  };
}
