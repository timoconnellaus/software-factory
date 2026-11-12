// The single invocation pipeline (ADR 0004, spec 01; the CRM's ADR 0018 and spike ADR 0110):
//
//   idempotency → validate → scope + policy (default-branch SHA) → actor check → kill switch →
//   gate check → fencing token → permission → handler → output check →
//   ONE D1 batch: the handler's writes and guards + the audit row + the outbox rows → deliver.
//
// A `review` answer does not run the handler: it records a pending action (in one batch with its
// audit and notify rows) and returns `pending`. The approved re-run passes `approvalId`.
import {
  clearGuards,
  createDb,
  type Db,
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
  PendingActionRow,
  Scope,
} from "./operation.ts";
import {
  type Decision,
  type FloorParse,
  operationGate,
  parseFloor,
  type RiskClass,
} from "./policy/gate.ts";
import { getOperation } from "./registry.ts";
import {
  activeKillSwitch,
  approverIds,
  checkPermission,
  defaultScopeRef,
  resolveScope,
  resumeEventType,
} from "./scope.ts";
import type { FactoryServices } from "./services.ts";

export interface InvokeDeps {
  d1: D1Database;
  services: FactoryServices;
  /** The global floor, JSON (env `FACTORY_FLOOR`). Malformed: every call is denied. */
  floor?: string | undefined;
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
  /** The approved pending action this call carries out. */
  approvalId?: string;
}

export type InvokeResult<O = unknown> =
  | { status: "ok"; output: O; auditId: string | null }
  | { status: "pending"; pendingActionId: string; auditId: string };

type Outcome = "ok" | "review" | "denied" | "forbidden" | "killed" | "fenced" | "failed";

interface AuditFields {
  decision: Decision | "n/a";
  outcome: Outcome;
  reason?: string | undefined;
  result?: unknown;
  diff?: Change[];
  pendingActionId?: string;
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

/**
 * Whether a device surface's presence proof may decide `op` at all (ADR 0391, 0541), and for this
 * input when one is given: an input the phone refuses (`mobileRefuses`) takes no proof there.
 */
export function presenceSurfaceAllowed(
  op: AnyOperation,
  surface: DeviceSurface,
  input?: unknown,
): boolean {
  if (surface === "mobile" && phoneRefuses(op, input)) return false;
  const surfaces = op.presenceSurfaces ?? (op.presenceDecidable ? ["desktop", "mobile"] : []);
  return surfaces.includes(surface);
}

/** Whether the phone may not decide this input of `op` at all (`mobileRefuses`). */
export function phoneRefuses(op: AnyOperation, input: unknown): boolean {
  return (
    !!op.mobileRefuses &&
    input !== null &&
    typeof input === "object" &&
    op.mobileRefuses(input as Record<string, unknown>)
  );
}

async function presenceAllows(op: AnyOperation, origin: Origin, rawInput: unknown) {
  if (!isDeviceSurface(origin.surface) || !origin.presence) return false;
  if (!presenceSurfaceAllowed(op, origin.surface, rawInput)) return false;
  if (origin.presence.op !== op.name) return false;
  return origin.presence.inputDigest === (await inputDigest(rawInput));
}

/**
 * Whether a person on this device surface may run a browser-only operation with one tap, without a
 * presence proof (ADR 0470 and 0541 decision 5; replaces the bare `desktopDecidable` check). On the
 * desktop: `desktopDecidable`. On the phone: that, or `mobileDecidable` (for this input).
 */
export function deviceDecidable(
  op: AnyOperation,
  surface: DeviceSurface,
  input: Record<string, unknown>,
): boolean {
  if (surface === "mobile" && phoneRefuses(op, input)) return false;
  if (op.desktopDecidable) return true;
  if (surface !== "mobile" || !op.mobileDecidable) return false;
  return op.mobileDecidable === true || op.mobileDecidable(input);
}

export async function runOperation<O = unknown>(
  deps: InvokeDeps,
  op: AnyOperation,
  rawInput: unknown,
  options: InvokeOptions,
): Promise<InvokeResult<O>> {
  const { actor, origin, idempotencyKey, approvalId } = options;
  const d1 = deps.d1;
  const db = createDb(d1);
  const now = (deps.now?.() ?? new Date()).toISOString();

  // 1. Idempotency: a retried Workflow step must not apply a write (or open a gate) twice.
  if (idempotencyKey) {
    const prior = await db
      .selectFrom("core_audit")
      .select(["id", "outcome", "result", "pending_action_id", "reason"])
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (prior?.outcome === "ok") {
      return { status: "ok", output: parse(prior.result) as O, auditId: prior.id };
    }
    if (prior?.outcome === "review" && prior.pending_action_id) {
      return { status: "pending", pendingActionId: prior.pending_action_id, auditId: prior.id };
    }
    if (prior && prior.outcome !== "failed") {
      const details = parse(prior.result) as Record<string, unknown> | null;
      if (typeof details?.concealedAs === "string") {
        throw new OperationError("not_found", details.concealedAs);
      }
      throw new OperationError(
        refusalCode(prior.outcome),
        prior.reason ?? prior.outcome,
        details ?? undefined,
      );
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
  let risk: RiskClass = op.risk;
  const floor = parseFloor(deps.floor);
  const redacted = op.redact?.input ? op.redact.input(input) : input;
  // A runner's input is machine chatter (manifests, event batches already kept in core_run_events):
  // the audit keeps its digest and the ids a reader follows, not the body (ADR 0590).
  const redactedInput = actor.type === "runner" ? await auditDigest(redacted) : redacted;

  let scope: Scope = {
    orgId: null,
    projectId: null,
    workItemId: null,
    workItem: null,
    project: null,
    repositories: [],
    repository: null,
    policy: null,
    rawPolicy: null,
    policySha: null,
    policyError: null,
    pinnedPolicy: null,
  };
  const audit = (fields: AuditFields, subject: Partial<Scope> = scope) =>
    auditStatement(d1, {
      now,
      actor,
      origin,
      idempotencyKey,
      operation: op.name,
      risk,
      input: redactedInput,
      approvalId,
      orgId: subject.orgId ?? null,
      projectId: subject.projectId ?? null,
      workItemId: subject.workItemId ?? null,
      policySha: subject.policySha ?? null,
      ...fields,
    });
  const refuse = async (fields: AuditFields, error: OperationError): Promise<never> => {
    await audit({ ...fields, result: error.details }).run();
    throw error;
  };

  // 4. Scope and policy: the work item / project / org this call is about, and the project's
  //    `.factory/` policy at its default-branch SHA (ADR 0036).
  //    One D1 round trip: the lookups and the human caller's org role go as one batch.
  let knownRole: string | null | undefined;
  try {
    const { role, ...resolved } = await resolveScope(
      db,
      op.scope ? await op.scope(input, db) : defaultScopeRef(input),
      {
        d1,
        userId: actor.type === "human" ? actor.id : null,
        skipOrgWorkflow: op.skipsOrgWorkflow === true,
      },
    );
    scope = resolved;
    knownRole = role;
  } catch (error) {
    if (error instanceof OperationError) {
      if (op.concealAs && error.code === "not_found") {
        const message = op.concealAs(input);
        return refuse(
          { decision: "n/a", outcome: "failed", reason: error.message },
          new OperationError("not_found", message),
        );
      }
      return refuse({ decision: "n/a", outcome: "failed", reason: error.message }, error);
    }
    throw error;
  }

  // A risk that depends on the scope (a config save that loosens the current version, ADR 0370).
  if (op.riskOf) risk = await op.riskOf(input, { scope, floor, db });

  // 4b. Actor check (after the scope, so the refusal is audited against it).
  if (!op.actors.includes(actor.type)) {
    return refuse(
      {
        decision: "n/a",
        outcome: "forbidden",
        reason: `actor ${actor.type} may not call ${op.name}`,
      },
      new OperationError("forbidden", `${actor.type} may not call ${op.name}`),
    );
  }

  // 4c. Browser-only decisions (ADR 0340): a person decides gates in the app, never through a
  //     token another surface holds (the CLI, MCP), which an agent session might be using. A
  //     desktop or phone may make a presence-decidable one with a Touch ID or fingerprint proof the
  //     client door redeemed for exactly this operation and input (ADR 0391, 0541), and a
  //     device-decidable one with one tap (ADR 0470, 0541).
  if (
    actor.type === "human" &&
    origin.surface !== "app" &&
    origin.surface !== "test" &&
    op.browserOnly &&
    (op.browserOnly === true || op.browserOnly(input)) &&
    !(isDeviceSurface(origin.surface) && deviceDecidable(op, origin.surface, input)) &&
    !(await presenceAllows(op, origin, rawInput))
  ) {
    return refuse(
      {
        decision: "n/a",
        outcome: "forbidden",
        reason: `${op.name} is browser-only (surface ${origin.surface})`,
      },
      new OperationError(
        "forbidden",
        `${op.name} is a decision you make in the app, not from ${origin.surface} (ADR 0340)`,
        { browserOnly: true },
      ),
    );
  }

  // 5. Kill switch (ADR 0044): non-human writes to a covered item are refused. The details name the
  //    event that releases a parked Workflow step.
  if (actor.type !== "human" && risk !== "read" && !op.allowWhenKilled) {
    const kill = await activeKillSwitch(db, scope.orgId, scope.projectId);
    if (kill) {
      const details = { ...kill, resumeEvent: resumeEventType(kill) };
      return refuse(
        { decision: "n/a", outcome: "killed", reason: `kill switch on (${kill.scope})` },
        new OperationError("killed", `the ${kill.scope} kill switch is on`, details),
      );
    }
  }

  // 6. Gate check: actor × risk class under the autonomy policy, overrides and floor. Calls with no
  //    project (runner registration, the claim loop) are judged under Cautious + the floor, and so
  //    are calls that bring the policy in (`bootstrapsPolicy`).
  const scoped = scope.project !== null && !op.bootstrapsPolicy;
  // A work item stays at least as strict as the config version it started under (ADR 0370 §5), and
  // an `alwaysReview` operation always asks a person (ADR 0371): `operationGate` does both.
  const gate = operationGate({
    op,
    actor: actor.type,
    risk,
    policy: scoped
      ? scope.policy
        ? { autonomyPolicy: scope.policy.autonomyPolicy, overrides: scope.policy.overrides }
        : null
      : { autonomyPolicy: "cautious", overrides: {} },
    ...(scope.policyError ? { policyError: scope.policyError } : {}),
    floor,
    pinnedPolicy:
      scoped && scope.policy && scope.pinnedPolicy
        ? {
            autonomyPolicy: scope.pinnedPolicy.autonomyPolicy,
            overrides: scope.pinnedPolicy.overrides,
          }
        : null,
  });

  // An approved re-run must match its pending action. `deny` still refuses it.
  let approval: PendingActionRow | undefined;
  if (approvalId) {
    approval =
      (await db
        .selectFrom("core_pending_actions")
        .selectAll()
        .where("id", "=", approvalId)
        .executeTakeFirst()) ?? undefined;
    if (
      approval?.status !== "approved" ||
      approval.operation !== op.name ||
      approval.actor_type !== actor.type ||
      approval.work_item_id !== scope.workItemId
    ) {
      return refuse(
        {
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
      { decision: "deny", outcome: "denied", reason: gate.reason },
      new OperationError("denied", `${op.name} denied for ${actor.type}: ${gate.reason}`),
    );
  }

  // 7. Fencing (ADR 0035): a lease holder's write must carry the current token.
  let fence: { workItemId: string; token: number } | null = null;
  if (op.fenced) {
    const token = input.fencingToken;
    if (typeof token !== "number" || !scope.workItemId) {
      throw new Error(`fenced operation ${op.name} needs fencingToken and a work item`);
    }
    const lease = await db
      .selectFrom("core_leases")
      .select("fencing_token")
      .where("work_item_id", "=", scope.workItemId)
      .executeTakeFirst();
    if (!lease || lease.fencing_token !== token) {
      const current = lease?.fencing_token ?? null;
      return refuse(
        { decision: gate.decision, outcome: "fenced", reason: `stale fencing token ${token}` },
        new OperationError("fenced", `stale fencing token ${token} (current ${current})`, {
          fencingToken: token,
          current,
        }),
      );
    }
    fence = { workItemId: scope.workItemId, token };
  }

  // 8. Permission (humans).
  try {
    const permission = op.permissionOf
      ? await op.permissionOf(input, { scope, db })
      : op.permission;
    await checkPermission(db, actor, permission, scope, knownRole);
  } catch (error) {
    if (error instanceof OperationError && op.concealAs) {
      // Audited as the forbidden call it is; answered as if there were nothing there.
      // The audit row keeps the answer given, so an idempotent replay gives the same one.
      const message = op.concealAs(input);
      await audit({
        decision: gate.decision,
        outcome: "forbidden",
        reason: error.message,
        result: { concealedAs: message },
      }).run();
      throw new OperationError("not_found", message);
    }
    if (error instanceof OperationError) {
      return refuse(
        { decision: gate.decision, outcome: "forbidden", reason: error.message },
        error,
      );
    }
    throw error;
  }

  // 9. Review: record a pending action instead of running the handler.
  if (gate.decision === "review" && !approval) {
    return openPendingAction(deps, db, {
      op,
      risk,
      input,
      redactedInput,
      scope,
      actor,
      origin,
      now,
      reason: gate.reason,
      audit,
      floor,
    }) as Promise<InvokeResult<O>>;
  }

  // 10. Run the handler: it reads now and queues its writes.
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
    floor,
    write: (statement) => {
      const prepared = isPrepared(statement) ? statement : toStatement(d1, statement);
      if (
        setsPendingStatus(isPrepared(statement) ? preparedSql(statement) : statement.compile().sql)
      ) {
        throw new Error(
          `${op.name} writes a pending action's status with write(): use writePendingStatus`,
        );
      }
      statements.push(prepared);
    },
    writePendingStatus: (how, statement) => {
      if (how === "decide" && !op.decidesPending) {
        throw new Error(
          `${op.name} decides a pending action but doesn't declare decidesPending in the registry`,
        );
      }
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
      subject = {
        ...subject,
        ...(ref.workItemId ? { workItemId: ref.workItemId } : {}),
        ...(ref.projectId ? { projectId: ref.projectId } : {}),
        ...(ref.orgId ? { orgId: ref.orgId } : {}),
      };
    },
    ...(approval ? { approval } : {}),
  };

  let output: unknown;
  try {
    output = op.output.parse(await op.handler(input, ctx));
  } catch (error) {
    const failed = audit(
      { decision: gate.decision, outcome: "failed", reason: String(error) },
      subject,
    );
    if (approval && error instanceof OperationError && error.details?.closeApproval === true) {
      // The approved re-run can never succeed (pr.merge: the head moved after the person approved):
      // close the approval with why, rather than leave it `approved` for a commit that won't land.
      await d1.batch([
        d1
          .prepare(
            "UPDATE core_pending_actions SET status = 'rejected', decision = 'withdrawn', note = ? WHERE id = ? AND status = 'approved'",
          )
          .bind(error.message, approval.id),
        failed,
      ]);
    } else {
      await failed.run();
    }
    throw error;
  }
  if (risk === "read") {
    if (statements.length > 0 || messages.length > 0) {
      throw new Error(`read operation ${op.name} queued writes`);
    }
    return { status: "ok", output: output as O, auditId: null };
  }

  // 11. One batch: writes + guards + fence + approval consumed + audit + outbox. All or nothing.
  //     A changes-only operation that changed nothing writes no audit row (ADR 0590).
  const audited =
    !op.audit?.changesOnly ||
    idempotencyKey !== undefined ||
    approval !== undefined ||
    changed ||
    changes.length > 0 ||
    messages.length > 0 ||
    op.audit.changed?.(output) === true;
  const auditId = audited ? newId("audit") : null;
  // Nothing to write and nothing to audit: no batch at all. Its fence and device guards only
  // protect writes, and each guard costs an insert and a delete (rows written).
  if (!auditId && statements.length === 0 && messages.length === 0) {
    return { status: "ok", output: output as O, auditId: null };
  }
  const outboxIds = messages.map(() => newId("outbox"));
  // A desktop's or phone's call holds only while the device does: removing it while a decision is
  // on its way refuses the decision, in the same batch that would apply it (review of spec 60 PR
  // 1a). First, so it reads the device as it was before this call's own writes.
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
    ...(fence
      ? [
          d1
            .prepare(
              "INSERT INTO core_batch_guard (name, ok) SELECT 'fence', EXISTS (SELECT 1 FROM core_leases WHERE work_item_id = ? AND fencing_token = ?)",
            )
            .bind(fence.workItemId, fence.token),
        ]
      : []),
    ...(approval
      ? [
          d1
            .prepare(
              "UPDATE core_pending_actions SET status = 'applied' WHERE id = ? AND status = 'approved'",
            )
            .bind(approval.id),
          guardChanged(d1, "approval used once"),
        ]
      : []),
    ...(auditId
      ? [
          audit(
            {
              decision: gate.decision,
              outcome: "ok",
              reason: approval
                ? `approved (${approval.id}) by ${approval.decided_by}`
                : gate.reason,
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
    const fenced = guard && fence && /fence/.test(String(error));
    await audit(
      {
        decision: gate.decision,
        outcome: fenced ? "fenced" : "failed",
        reason: guard
          ? `conflict: a guarded write found the state changed (${String(error)})`
          : String(error),
      },
      subject,
    ).run();
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
      throw new OperationError("conflict", `${op.name}: the state changed underneath this call`);
    }
    throw error;
  }

  // 12. After commit: deliver. A failed send leaves the row for the cron; the caller still succeeds.
  if (deps.deliver && outboxIds.length > 0) {
    try {
      await deps.deliver(outboxIds);
    } catch (error) {
      console.error(`outbox delivery after ${op.name} failed; the cron will retry`, error);
    }
  }
  return { status: "ok", output: output as O, auditId };
}

async function openPendingAction(
  deps: InvokeDeps,
  db: Db,
  args: {
    op: AnyOperation;
    risk: RiskClass;
    input: Record<string, unknown>;
    redactedInput: unknown;
    scope: Scope;
    actor: Actor;
    origin: Origin;
    now: string;
    reason: string;
    audit: (fields: AuditFields, subject?: Partial<Scope>) => D1PreparedStatement;
    floor: FloorParse;
  },
): Promise<InvokeResult> {
  const { op, risk, scope, actor, origin, now, reason, audit } = args;
  const d1 = deps.d1;
  const pendingActionId = newId("pendingAction");
  const auditId = newId("audit");
  const outboxId = newId("outbox");
  const kind = op.gateKind ?? "approval";
  // The requester decides when they are an approver; otherwise the first approver.
  const orgAdmin = op.decidedByOrgAdmin
    ? await op.decidedByOrgAdmin(args.input, { scope, floor: args.floor, db })
    : false;
  // An org admin decides a loosening of the project's org workflow: the org's owners and admins.
  const approvers = scope.orgId
    ? await approverIds(db, scope.orgId, orgAdmin ? null : scope.policy)
    : [];
  const requester = scope.workItem?.requester_user_id;
  // A gate step may name who decides (ADR 0371); they must be one of the project's approvers.
  const named = op.assignee?.(args.input) ?? null;
  const namedId =
    named && scope.orgId
      ? ((await approverIds(db, scope.orgId, { approvers: [named] }))[0] ?? null)
      : null;
  const assignee =
    namedId && approvers.includes(namedId)
      ? namedId
      : requester && approvers.includes(requester)
        ? requester
        : (approvers[0] ?? null);
  const hours = scope.policy?.timeouts.gateHours ?? 72;
  const timeoutAt = new Date(Date.parse(now) + hours * 3_600_000).toISOString();
  const title =
    kind === "spec"
      ? `Spec ready for approval: ${scope.workItem?.title ?? op.name}`
      : kind === "merge"
        ? `Ready to merge: ${scope.workItem?.title ?? op.name}`
        : `Approval needed: ${op.name}`;
  const notify: OutboxMessage = {
    kind: "notify",
    payload: {
      event: "gate.opened",
      userId: assignee,
      workItemId: scope.workItemId,
      title,
      url: scope.workItemId ? `/?item=${scope.workItemId}` : "/",
    },
  };
  const statements = [
    d1
      .prepare(
        `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, workflow_id, kind, operation, risk,
           actor_type, actor_id, input, reason, assignee_user_id, timeout_at, policy_sha, created_at, decider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pendingActionId,
        scope.orgId,
        scope.projectId,
        scope.workItemId,
        origin.workflowId ?? scope.workItem?.workflow_id ?? null,
        kind,
        op.name,
        risk,
        actor.type,
        actor.id,
        JSON.stringify(args.input),
        reason,
        assignee,
        timeoutAt,
        scope.policySha,
        now,
        orgAdmin ? "org-admin" : null,
      ),
    ...(scope.workItemId
      ? [
          d1
            .prepare(
              "UPDATE core_work_items SET status = 'waiting', updated_at = ? WHERE id = ? AND status = 'running'",
            )
            .bind(now, scope.workItemId),
        ]
      : []),
    audit({
      decision: "review",
      outcome: "review",
      reason,
      pendingActionId,
      auditId,
      result: { pendingActionId, kind, assignee },
    }),
    outboxStatement(d1, now, outboxId, notify),
  ];
  await d1.batch(statements);
  if (deps.deliver) {
    try {
      await deps.deliver([outboxId]);
    } catch (error) {
      console.error("outbox delivery failed; the cron will retry", error);
    }
  }
  return { status: "pending", pendingActionId, auditId };
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
    approvalId: string | undefined;
    orgId: string | null;
    projectId: string | null;
    workItemId: string | null;
    policySha: string | null;
  },
): D1PreparedStatement {
  // Only outcomes that settle a call claim the idempotency key; a failure may be retried.
  const key = fields.outcome === "failed" ? null : (fields.idempotencyKey ?? null);
  return d1
    .prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, reason,
         org_id, project_id, work_item_id, policy_sha, input, result, diff, pending_action_id, approval_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.auditId ?? newId("audit"),
      fields.now,
      fields.operation,
      fields.risk,
      fields.actor.type,
      fields.actor.id,
      JSON.stringify(fields.origin),
      fields.decision,
      fields.outcome,
      fields.reason ?? null,
      fields.orgId,
      fields.projectId,
      fields.workItemId,
      fields.policySha,
      JSON.stringify(fields.input ?? null),
      fields.result === undefined ? null : JSON.stringify(fields.result),
      JSON.stringify(fields.diff ?? []),
      fields.pendingActionId ?? null,
      fields.approvalId ?? null,
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

/**
 * Whether a statement sets a pending action's `status` (ADR 0541 amendment, third review): an
 * UPDATE of core_pending_actions whose SET clause names `status`. Its WHERE clause may.
 */
export function setsPendingStatus(sql: string): boolean {
  const update =
    /^\s*update\s+(?:or\s+\w+\s+)?"?core_pending_actions"?\s+set\s+([\s\S]*?)(?:\swhere\s[\s\S]*)?$/i.exec(
      sql,
    );
  return !!update && /(?:^|[\s,(])"?status"?\s*=/i.test(update[1] ?? "");
}

/**
 * A prepared statement's SQL. workerd's D1PreparedStatement keeps it as `statement`; anything
 * without one is treated as unreadable, which `write()` refuses rather than lets through.
 */
function preparedSql(statement: D1PreparedStatement): string {
  const sql = (statement as D1PreparedStatement & { statement?: unknown }).statement;
  if (typeof sql !== "string") throw new Error("a prepared statement without its SQL");
  return sql;
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

function refusalCode(outcome: Outcome) {
  switch (outcome) {
    case "killed":
      return "killed" as const;
    case "fenced":
      return "fenced" as const;
    case "forbidden":
      return "forbidden" as const;
    default:
      return "denied" as const;
  }
}

/** The fields of a runner's input the audit keeps beside the digest: what a reader follows. */
const DIGEST_KEEPS = ["jobId", "fencingToken", "claimId", "workItemId"] as const;

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
