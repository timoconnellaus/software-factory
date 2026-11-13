// defineOperation (ADR 0003): every factory verb is defined once with zod schemas, a model-facing
// description, a permission, a risk class and the actors allowed to call it. The app (through the
// engine's RPC), MCP and the runner channel all call operations through `invoke()`; nothing else
// writes to D1.
import type {
  CoreOrganizationTable,
  CorePendingActionsTable,
  CoreProjectsTable,
  CoreRepositoriesTable,
  CoreWorkItemsTable,
  Db,
} from "@software-factory/db";
import type { Compilable, Selectable } from "kysely";
import type { z } from "zod";
import type { Actor, ActorType, DeviceSurface, Origin } from "./actors.ts";
import type { FloorParse, RiskClass } from "./policy/gate.ts";
import type { ProjectPolicy } from "./policy/project-policy.ts";
import type { FactoryServices } from "./services.ts";

/**
 * Who among humans may call it (checked after the gate; non-human actors are governed by the gate
 * and `actors`):
 * - `signed-in`: any signed-in user (the handler checks ownership where it matters);
 * - `member`: a member of the work item's / project's org;
 * - `approver`: an approver of the project (`.factory/` approvers, else org owners and admins);
 * - `admin`: an owner or admin of the org.
 */
export const PERMISSIONS = ["signed-in", "member", "approver", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Messages written to the outbox in the operation's batch and delivered after commit by sf-engine. */
export type OutboxMessage =
  | { kind: "workflow.create"; payload: { instanceId: string; params: { workItemId: string } } }
  | {
      kind: "workflow.event";
      payload: { instanceId: string; type: string; payload: Record<string, unknown> };
    }
  | { kind: "workflow.pause"; payload: { instanceId: string } }
  /** Resume, then send each event type (releases steps parked by a kill switch). */
  | { kind: "workflow.resume"; payload: { instanceId: string; events: string[] } }
  | { kind: "workflow.terminate"; payload: { instanceId: string } }
  /**
   * A work item's planning changed (spec 20, ADR 0350): sf-engine tells its PlanningHub, which
   * pushes to open Planning tabs and wakes the agent's wait.
   */
  | { kind: "planning.changed"; payload: { workItemId: string } }
  /**
   * Run the babysitter's deliverer for one repository queue after this call commits (spec 53, ADR
   * 0580). `repositoryId` null: the project's items that record no repository.
   */
  | { kind: "delivery.wake"; payload: { projectId: string; repositoryId: string | null } }
  /** Run `queue.pull` for a project after this call commits (ADR 0491). */
  | { kind: "queue.pull"; payload: { projectId: string } }
  /**
   * A person steered a run (spec 31, ADR 0400): sf-engine wakes the work item's hub, so the runner
   * host's held steer call answers at once.
   */
  /**
   * A steer or takeover is queued for a running job (ADR 0400): pushed down the job's line (spec 44
   * part B). `jobId` is optional: a message queued before it was added is routed by the work item.
   */
  | { kind: "run.steered"; payload: { workItemId: string; jobId?: string } }
  /** A device was revoked (ADR 0541): sf-engine closes its live socket in the person's ClientHub. */
  | { kind: "device.revoked"; payload: { userId: string; deviceId: string } }
  /** A notification for a person (web push in spec 15). `url` is the deep link. */
  | {
      kind: "notify";
      payload: {
        event: string;
        userId?: string | null;
        workItemId?: string | null;
        title: string;
        url?: string;
      };
    };

export type OutboxKind = OutboxMessage["kind"];

export type WorkItemRow = Selectable<CoreWorkItemsTable>;
export type ProjectRow = Selectable<CoreProjectsTable>;
export type RepositoryRow = Selectable<CoreRepositoriesTable>;
export type OrgRow = Selectable<CoreOrganizationTable>;
export type PendingActionRow = Selectable<CorePendingActionsTable>;

/** What a call is about, resolved by `invoke()` before the gate. */
export interface Scope {
  orgId: string | null;
  projectId: string | null;
  workItemId: string | null;
  workItem: WorkItemRow | null;
  project: ProjectRow | null;
  /** The project's repositories, oldest first (ADR 0490). Empty without a project. */
  repositories: RepositoryRow[];
  /**
   * The repository the call is about: the work item's; else the input's `repositoryId`; else the
   * project's only one. Null when none applies (no repository, or several and none named).
   */
  repository: RepositoryRow | null;
  /**
   * The project's policy at `policySha`, as the factory runs it: on an org workflow (spec 52 PR
   * (d)), with the workflow and its overrides resolved into it (`effectivePolicy`). Null when
   * missing, malformed or unresolvable (fails closed).
   */
  policy: ProjectPolicy | null;
  /** The project's config document as saved, before the org workflow is resolved into it. */
  rawPolicy: ProjectPolicy | null;
  policySha: string | null;
  policyError: string | null;
  /**
   * The config version the work item was created under, when it differs from the current one
   * (ADR 0370 §5): the gate uses the stricter of the two. On an org workflow it is resolved under
   * the org config version the item pinned. Null otherwise, or when it isn't valid.
   */
  pinnedPolicy: ProjectPolicy | null;
}

/** What a call names in its input, from which `invoke()` resolves the scope. */
export interface ScopeRef {
  workItemId?: string | null;
  projectId?: string | null;
  /** A repository of the project (ADR 0490); names the project too when `projectId` is absent. */
  repositoryId?: string | null;
  orgId?: string | null;
  jobId?: string | null;
  questionId?: string | null;
  pendingActionId?: string | null;
}

/** One record touched, for the audit row's diff (spec 01, criterion 6). */
export interface Change {
  entity: string;
  id: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Why a handler writes a pending action's status (`HandlerContext.writePendingStatus`). */
export type PendingStatusWrite = "decide" | "close" | "apply";

export interface HandlerContext {
  /** Typed reads. Writes go through `write()`: they commit in one batch after the handler. */
  db: Db;
  d1: D1Database;
  actor: Actor;
  origin: Origin;
  /** ISO time of this invocation; use it instead of reading the clock. */
  now: string;
  services: FactoryServices;
  scope: Scope;
  /** The global floor in force for this call (ADR 0008). */
  floor: FloorParse;
  /** Set when this call is the approved re-run of a pending action. */
  approval?: PendingActionRow;
  /**
   * The device sent a valid presence proof for exactly this call (ADR 0391, 0541). Lets a
   * `desktopDecidable` or `mobileDecidable` operation still ask for one for some inputs (spec 26).
   */
  presence?: boolean;
  /**
   * Queue a write. Writes, guards, the audit row and outbox rows commit in one D1 batch. It refuses
   * a write to a pending action's `status`: that goes through `writePendingStatus`.
   */
  write(statement: Compilable | D1PreparedStatement): void;
  /**
   * Queue the one kind of write `write` refuses: a pending action's `status` (ADR 0541 amendment,
   * 2026-11-12, third review). `decide` is `decidePending`'s, and only an operation that declares
   * `decidesPending` may make it; `close` withdraws or cancels one without deciding it (a take-back,
   * a moved head, a cancelled item); `apply` marks an approved one carried out.
   */
  writePendingStatus(how: PendingStatusWrite, statement: Compilable | D1PreparedStatement): void;
  /**
   * Queue a write that records something that already happened outside the factory (GitHub merged
   * the PR, spec 53 review). It commits with the batch; if a guard fails the batch, it commits
   * anyway in a second batch with the approval marked used and an audit row saying what happened,
   * so the record never says it didn't. Write it so it is right in both cases (it runs against the
   * state the guard found changed).
   */
  happened(statement: Compilable | D1PreparedStatement): void;
  /** Abort the whole batch unless the previous write changed at least one row (ADR 0050). */
  guardChanged(name: string): void;
  /** Abort the whole batch unless `query` returns a row when the batch runs. */
  guardExists(name: string, query: Compilable): void;
  /** Queue an outbox message, committed in the same batch and delivered after commit. */
  emit(message: OutboxMessage): void;
  /** Record a change for the audit row's diff. */
  change(change: Change): void;
  /**
   * Mark this call as one that changed something a person may want to read later, without a diff:
   * a changes-only operation (`audit.changesOnly`) then writes its audit row (ADR 0590).
   */
  changed(): void;
  /** Point the audit row at a work item / project the input didn't name (e.g. a created one). */
  subject(ref: { workItemId?: string; projectId?: string; orgId?: string }): void;
}

export interface Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  /** Model-facing copy: what it does, when to use it, what it refuses. */
  description: string;
  /** The declared risk class (and the default for `riskOf`). */
  risk: RiskClass;
  /**
   * A risk that depends on the input, e.g. a merge whose diff touches `.factory/` is self-modify, or
   * on the resolved scope, e.g. a config save that loosens the current version (ADR 0370). Called
   * once the scope is known; refusals audited before that carry the declared `risk`.
   */
  riskOf?: (
    input: z.output<I>,
    at: { scope: Scope; floor: FloorParse; db: Db },
  ) => RiskClass | Promise<RiskClass>;
  /**
   * A `review` answer that only an org owner or admin may decide, not the project's approvers (a
   * project config save that loosens its org workflow, spec 52 Q6). The pending action is assigned
   * to the org's admins and marked so `approval.decide` asks for one.
   */
  decidedByOrgAdmin?: (
    input: z.output<I>,
    at: { scope: Scope; floor: FloorParse; db: Db },
  ) => Promise<boolean>;
  /**
   * The handler reads nothing an org workflow decides (stages, agents, spec size, retries, checks,
   * review sections), and nor does the gate for it: a polled read. The scope then doesn't resolve
   * the project's org workflow: `policy` is the project's config as saved (spec 52 PR (d), cost).
   */
  skipsOrgWorkflow?: true;
  /** A permission that depends on the resolved scope (who may decide a pending action). */
  permissionOf?: (input: z.output<I>, at: { scope: Scope; db: Db }) => Promise<Permission>;
  input: I;
  output: O;
  /** Actor types that may call it at all (checked before the gate). */
  actors: readonly ActorType[];
  /** What a human needs (see `Permission`). */
  permission: Permission;
  /** Writes from a lease holder: the input's `fencingToken` must be the work item's current one. */
  fenced?: boolean;
  /** Still runs for non-humans while a kill switch covers the item (e.g. a runner releasing). */
  allowWhenKilled?: boolean;
  /**
   * The call is how a project's policy arrives (the connector mirroring `.factory/policy.json` from a
   * default-branch push), so it can't wait for one: the gate judges it as for an unscoped call
   * (Cautious + the floor) instead of failing closed on a missing or malformed policy. Only for
   * operations that apply nothing but default-branch content.
   */
  bootstrapsPolicy?: boolean;
  /**
   * A decision only a person in the browser makes (ADR 0340): gate decisions, answers, device
   * approvals, turning a kill switch off. `invoke()` refuses it for a human on any surface but
   * `app`, so a CLI or MCP token an agent might hold can never approve anything. A function
   * decides per input (a kill switch may be turned on from a terminal, not off).
   */
  browserOnly?: true | ((input: z.output<I>) => boolean);
  /**
   * A browser-only decision a person may also make from a desktop device with a presence proof for
   * this exact call (ADR 0391): spec, merge, approval and question decisions. Never set on
   * operations that grant authority (device logins, runner registration, kill switch off).
   */
  presenceDecidable?: true;
  /**
   * The device surfaces whose presence proof the operation takes (ADR 0541). Defaults to both for
   * a `presenceDecidable` gate decision, and to none otherwise. Set on its own, it marks an
   * operation that isn't a gate decision but takes a proof on those devices: adding a phone from
   * the desktop (`mobile.pairOffer`), renewing a phone's token (`mobile.renew`), turning a device's
   * approvals back on (`device.update`).
   */
  presenceSurfaces?: readonly DeviceSurface[];
  /**
   * A person-only operation (browser-only) that a desktop device may also run *without* a presence
   * proof. The CLI and MCP surfaces stay refused, so an agent holding a token can't; gates keep their
   * presence proof. It covers (spec 26; ADR 0042, 0391 and 0470 as amended):
   * - `planning.answer` and `planning.acceptDefaults`: answering the planner is a conversation, not a
   *   gate (the owner's decision of 2026-11-12: "touch id approvals is overkill. We'll assume the
   *   user's computer is secure"). Security, privacy and irreversible answers still ask for a proof
   *   (`ctx.presence`);
   * - `planning.finishAlone`: the standing form of that bulk accept, within the same limits;
   * - `planning.stop`, `planning.pause`, `planning.resume` and `chat.send` with `interrupt`: steering
   *   the planner, which changes nothing it has decided;
   * - `workItem.releaseChoice`: a person's choice for an item flagged at release (spec 52, Q4),
   *   which holds work back or releases it under the gates that apply anyway.
   */
  desktopDecidable?: true;
  /**
   * A person-only operation the phone may run with one tap, without a fingerprint (ADR 0541
   * decision 5, the owner's rule "ordinary answers are one tap"): everything `desktopDecidable`,
   * and these, which only ever hold work back or answer: `question.answer` (security, privacy and
   * irreversible questions still ask for the fingerprint, through `ctx.presence`),
   * `question.acceptDefaults`, `review.sendBack`, `spec.requestChanges`, and `approval.decide`
   * when rejecting. A function decides per input. `deviceDecidable()` combines the two.
   */
  mobileDecidable?: true | ((input: z.output<I>) => boolean);
  /**
   * Inputs the phone may not decide at all, proof or no proof: they stay on the desktop app or the
   * website. `review.merge` with `mergeWithoutChecks` (ADR 0501, fifth review: merging without
   * checks the runner couldn't run is not a phone decision until the owner decides otherwise).
   * Takes the raw input, as the presence challenge sees it.
   */
  mobileRefuses?: (input: Record<string, unknown>) => boolean;
  /**
   * The operation decides a pending action (approves, rejects or sends one back), through
   * `decidePending` (gates.ts), which checks who may decide what: the phone may not decide a config
   * change or anything self-modify (ADR 0541). `decidePending` refuses an operation that doesn't
   * declare this, and a test runs every operation that does from the phone. Withdrawing,
   * cancelling and applying aren't deciding (`HandlerContext.writePendingStatus`).
   */
  decidesPending?: true;
  /**
   * The gate always asks a person, whatever the autonomy policy or overrides say (a workflow's gate
   * step, ADR 0371). `deny` still refuses.
   */
  alwaysReview?: boolean;
  /**
   * A write operation that, when its handler queued nothing (no write, event or change), commits
   * nothing either: no audit row (spec 53 review, the Cloudflare cost rule). For observations
   * repeated on every webhook (`main.observe`), where only a change is worth a row. Its
   * idempotency key then records nothing, so a retry runs it again: it must be safe to repeat.
   */
  quietWhenUnchanged?: true;
  /** Who should decide a `review` (a GitHub login); falls back to the approvers. */
  assignee?: (input: z.output<I>) => string | null;
  /** Which inbox card a `review` answer becomes. Default `approval`. */
  gateKind?: "spec" | "merge" | "approval";
  /**
   * Hide what the caller may not see (ADR 0310): when set, a scope that can't be resolved and a human
   * without the permission both get `not_found` with this message, so a missing record and one in
   * an org the caller can't reach look the same.
   */
  concealAs?: (input: z.output<I>) => string;
  /** How to find the scope when the default (input field names) isn't enough. */
  scope?: (input: z.output<I>, db: Db) => Promise<ScopeRef>;
  /**
   * Machine-frequency operations (a heartbeat, an empty claim, a held wait, presence; ADR 0590,
   * AGENTS.md "Cloudflare cost" rule 12) write no audit row unless the call changed state: the handler
   * called `ctx.change` or `ctx.changed`, queued an outbox message, or `changed(output)` is true.
   * Refusals and failures are always audited, and so is a call with an idempotency key.
   */
  audit?: { changesOnly: true; changed?: (output: z.output<O>) => boolean };
  /** Strip secrets before the input/output is written to the audit journal. */
  redact?: { input?: (input: z.output<I>) => unknown; output?: (output: z.output<O>) => unknown };
  handler(input: z.output<I>, ctx: HandlerContext): Promise<z.input<O>>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds operations of every input/output type.
export type AnyOperation = Operation<any, any>;

export function defineOperation<I extends z.ZodType, O extends z.ZodType>(
  op: Operation<I, O>,
): Operation<I, O> {
  return op;
}
