// The reconciler (spec 52 "B", ADR 0511): a pure function from an item's snapshot to its next
// action. Build plan PR (c): it runs in shadow beside today's Workflow and drives nothing; the
// shadow recorder compares what it would do with what the Workflow did.
//
// The item's state of record is its stage entries (one per entry into a stage, with a round) and
// its step attempts (one per job, gate or operation inside an entry). A stage type's `next()` reads
// its own entry and steps and returns one action; `reconcile()` walks the definition: which stage
// is current, whether the next one is skipped, whether the item waits for release, and when it is
// done.

import type { GateSpec, ItemFacts, Size } from "./contract.ts";
import { workflowImpact } from "./impact.ts";
import { stageType } from "./registry.ts";
import type { Condition } from "./settings.ts";
import { conditionHolds } from "./settings.ts";
import type { StageInstance, WorkflowDefinition } from "./workflow.ts";

/** One entry into a stage. A send-back or a changes-requested gate starts a new round. */
export interface StageEntry {
  stageId: string;
  round: number;
  typeVersion: number;
  status: "active" | "done" | "skipped" | "sent_back" | "failed";
  /** Notes carried in by a send-back (the checks' failures, a reviewer's note). */
  note?: string | null;
  /** A send-back that isn't a failed attempt: a person's at the merge gate, or a head that moved. */
  free?: boolean;
}

/** One attempt at a step inside a stage entry: a job, a gate or an operation. */
export interface StepAttempt {
  stageId: string;
  round: number;
  /** The step id from the type's `steps()`: "triage", "session", "spec-gate", "build", … */
  stepId: string;
  attempt: number;
  status:
    | "running"
    | "ok"
    | "failed"
    | "pending"
    | "approved"
    | "rejected"
    | "changes_requested"
    | "sent_back";
  /** What the step reported, for a type to read (an agent check's verdict, the checks' failures). */
  output?: { verdict?: "pass" | "sendBack" | "ask"; note?: string; failures?: string[] };
  /** The head SHA a gate decided on (the merge gate's approval holds for that head only). */
  headSha?: string;
}

/** What the outside world looked like when the snapshot was read (spec 52: observations). */
export interface Observations {
  /** CI on the PR's head SHA. `missing`: nothing reported yet. */
  ci?: "pass" | "fail" | "pending" | "missing";
  /** The merge queue: whether this item holds the head of the queue. */
  queueTurn?: boolean;
  merged?: boolean;
  /** The PR's head SHA now. A merge approval for another head doesn't hold (as today). */
  headSha?: string;
  /**
   * An approval the babysitter carried to `headSha` (spec 53, ADR 0581/0582): it proved the approved
   * change unchanged across a clean merge of the default branch (and, from Workflow v12, the new
   * head passed its own verification). It holds for that head as the person's own approval would.
   */
  carriedApproval?: { headSha: string };
}

export interface ItemSnapshot {
  item: ItemFacts & {
    /** The foreman's request about the spec at triage, if any. */
    specRequested?: "skip" | "require";
    /** Released (Ready → Queued, ADR 0491): delivery stages may run. */
    released: boolean;
    /** Automatic retries of a failed build or verify (the project's, until PR (d)). */
    retryLimit: number;
    cancelled?: boolean;
  };
  /** The definition the item runs: the workflow version it is pinned to. */
  definition: WorkflowDefinition;
  /** The pinned version's number, when known. */
  version?: number;
  /**
   * The workflow's current version, when it is newer than the pinned one. The owner's answers:
   * a tightening (or neutral) change reaches a running item at its next stage boundary (Q3); at
   * release the item takes the current version when its shaping stages are unchanged, and is
   * flagged for a person otherwise (Q4). A loosening never reaches a running item.
   */
  latest?: { version: number; definition: WorkflowDefinition };
  stages: readonly StageEntry[];
  steps: readonly StepAttempt[];
  observations: Observations;
}

/** The one thing to do next. The executor carries it out through `invoke()` (ADR 0511). */
export type ReconcileAction =
  | { kind: "enter"; stageId: string; round: number }
  | { kind: "skip"; stageId: string; reason: string }
  | { kind: "job"; stageId: string; stepId: string; attempt: number }
  | {
      kind: "gate";
      stageId: string;
      stepId: string;
      gateKind: string;
      operation: string;
      /** A person decides it whatever the policy (the gate spec's `alwaysReview`). */
      alwaysReview: boolean;
    }
  | { kind: "operation"; stageId: string; stepId: string; operation: string }
  | { kind: "wait"; stageId: string | null; why: WaitReason }
  | { kind: "complete"; stageId: string }
  | {
      kind: "sendBack";
      stageId: string;
      /** The stage to go back to; "" the builder, `RECHECK` the stage that checks this one's input. */
      to: string;
      note: string;
      /** Not a failed attempt (a person's merge send-back, a moved head): not counted. */
      free?: true;
    }
  | { kind: "done" }
  | { kind: "fail"; stageId: string; reason: string }
  | { kind: "reject"; stageId: string; reason: string }
  /** Hand the item to a person: the reconciler can't go on safely (never a failure). */
  | { kind: "flag"; stageId: string | null; reason: string }
  /** Move the item to the workflow's current version (Q3, Q4), then reconcile again. */
  | { kind: "repin"; version: number; reason: string };

export type WaitReason = "release" | "run" | "gate" | "ci" | "queue" | "merge" | "cancelled";

/** What a type's `next()` sees: its own settings, the item, its current entry and that entry's steps. */
export interface NextContext<S> {
  settings: S;
  item: ItemSnapshot["item"];
  entry: StageEntry;
  steps: readonly StepAttempt[];
  observations: Observations;
  /** The type's gate for these settings, from the registry (its operation, risk, `alwaysReview`). */
  gate: GateSpec | null;
  /**
   * Failed attempts so far, across the whole item, as today's Workflow counts them: a failed job
   * (build, verify, a session), a failed check, and a send-back by an agent check or a decision
   * step. A person's send-back at the merge gate, a cancelled run and a head that moved don't count.
   * The item fails once this passes its retry limit.
   */
  failures: number;
}

/** What a type's `next()` may return: an action inside its stage, or the stage's end. */
export type StageAction = Exclude<
  ReconcileAction,
  { kind: "enter" } | { kind: "skip" } | { kind: "done" } | { kind: "flag" } | { kind: "repin" }
>;

/** The idempotency key every executed action carries (ADR 0511 §3). */
export function actionKey(
  itemId: string,
  a: { stageId: string; round: number; stepId: string; attempt: number },
): string {
  return `${itemId}:${a.stageId}:${a.round}:${a.stepId}:${a.attempt}`;
}

/**
 * The latest attempt of a step in this entry and its position. Steps are in the order they were
 * recorded, so a later position is a later attempt, whatever the step.
 */
export function latest(
  steps: readonly StepAttempt[],
  stepId: string,
): { step: StepAttempt; at: number } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as StepAttempt;
    if (step.stepId === stepId) return { step, at: i };
  }
  return undefined;
}

const count = (steps: readonly StepAttempt[], stepId: string, status?: StepAttempt["status"]) =>
  steps.filter((s) => s.stepId === stepId && (!status || s.status === status)).length;

/**
 * A job step: start it, wait for it, retry a failure up to `retries` times in this entry, then fail
 * the stage. Returns null once its latest attempt is ok, so the caller goes on.
 */
export function jobStep(
  ctx: NextContext<unknown>,
  stepId: string,
  retries: number,
): StageAction | null {
  const at = ctx.entry.stageId;
  const last = latest(ctx.steps, stepId)?.step;
  const attempt = count(ctx.steps, stepId) + 1;
  if (!last) return { kind: "job", stageId: at, stepId, attempt };
  if (last.status === "running") return { kind: "wait", stageId: at, why: "run" };
  if (last.status === "failed") {
    // Counted across the item, not this entry, as today's Workflow does: retries in one entry and
    // rounds of entries can't multiply.
    if (ctx.failures > retries)
      return {
        kind: "fail",
        stageId: at,
        reason: `gave up after ${ctx.failures} failed attempts (${stepId})`,
      };
    return { kind: "job", stageId: at, stepId, attempt };
  }
  return null;
}

/** A stage's gate spec, required: a type whose `next()` opens a gate must declare one. */
export function gateOf(gate: GateSpec | null): GateSpec {
  if (!gate) throw new Error("this stage opens a gate, but its type declares none");
  return gate;
}

/**
 * A gate step after `after` (the work it decides on): open it once that work's latest attempt is
 * newer than the gate's, wait for the decision, and map it. Returns null once approved.
 */
export function gateStep(
  ctx: NextContext<unknown>,
  stepId: string,
  gate: Pick<GateSpec, "kind" | "operation" | "alwaysReview">,
  after: string | null,
  onChanges: (note: string) => StageAction,
): StageAction | null {
  const at = ctx.entry.stageId;
  const g = latest(ctx.steps, stepId);
  const work = after ? latest(ctx.steps, after) : undefined;
  if (!g || (work && work.at > g.at))
    return {
      kind: "gate",
      stageId: at,
      stepId,
      gateKind: gate.kind,
      operation: gate.operation,
      alwaysReview: gate.alwaysReview,
    };
  const last = g.step;
  if (last.status === "pending") return { kind: "wait", stageId: at, why: "gate" };
  if (last.status === "rejected")
    return {
      kind: "reject",
      stageId: at,
      reason: last.output?.note ?? `${gate.kind} gate rejected`,
    };
  if (last.status === "changes_requested" || last.status === "sent_back")
    return onChanges(last.output?.note ?? "");
  return null;
}

/**
 * Where a send-back from `inst` goes: the work that has to change. That is the nearest earlier stage
 * that builds the head (`git-head`), as today (a failed check, a reviewer's or a person's send-back
 * all go back to build). With none earlier, the nearest earlier stage that produces what `inst`
 * consumes (a Marketing draft); then the nearest later builder (a slot step before the build sends
 * a note to it); else the stage itself.
 */
export function producerOf(def: WorkflowDefinition, inst: StageInstance): string {
  const at = def.stages.findIndex((s) => s.id === inst.id);
  const produces = (s: StageInstance, kinds: readonly string[]) =>
    stageType(s.type)?.produces.some((k) => kinds.includes(k)) ?? false;
  const earlier = (kinds: readonly string[]) => {
    for (let i = at - 1; i >= 0; i--) {
      const s = def.stages[i] as StageInstance;
      if (produces(s, kinds)) return s.id;
    }
    return null;
  };
  const later = () => {
    for (let i = at + 1; i < def.stages.length; i++) {
      const s = def.stages[i] as StageInstance;
      if (produces(s, ["git-head"])) return s.id;
    }
    return null;
  };
  return (
    earlier(["git-head"]) ?? earlier(stageType(inst.type)?.consumes ?? []) ?? later() ?? inst.id
  );
}

/** Where a send-back from the stage `stageId` goes (see `producerOf`). */
export function sendBackTo(def: WorkflowDefinition, stageId: string): string {
  const inst = def.stages.find((s) => s.id === stageId);
  return inst ? producerOf(def, inst) : stageId;
}

/** A send-back target meaning "the stage that checks what this one acts on" (a moved head). */
export const RECHECK = "@recheck";

/** The nearest earlier stage producing what `inst` consumes: its input's checks. */
function checkerOf(def: WorkflowDefinition, inst: StageInstance): string {
  const at = def.stages.findIndex((s) => s.id === inst.id);
  const kinds = stageType(inst.type)?.consumes ?? [];
  for (let i = at - 1; i >= 0; i--) {
    const s = def.stages[i] as StageInstance;
    if (stageType(s.type)?.produces.some((k) => kinds.includes(k))) return s.id;
  }
  return inst.id;
}

/**
 * Whether a sent-back entry is a failed attempt, as today's Workflow counts them: an agent check's,
 * a decision step's or the checks' send-back that goes back to earlier work. A person's send-back at
 * the merge gate and a moved head are `free`; a step before the build that sends a note forward
 * (today's `afterSpec` slot) isn't counted either.
 */
function countsAsFailure(def: WorkflowDefinition, entry: StageEntry): boolean {
  if (entry.status !== "sent_back" || entry.free) return false;
  const from = def.stages.findIndex((s) => s.id === entry.stageId);
  const to = def.stages.findIndex((s) => s.id === sendBackTarget(entry));
  return from < 0 || to < 0 || to <= from;
}

/** Failed attempts across the whole item (`NextContext.failures`). */
export function failuresOf(snap: Pick<ItemSnapshot, "definition" | "stages" | "steps">): number {
  const jobs = snap.steps.filter((s) => s.status === "failed").length;
  const sendBacks = snap.stages.filter((e) => countsAsFailure(snap.definition, e)).length;
  return jobs + sendBacks;
}

/** The type's next action for the current entry. Types without `next()` aren't run by the reconciler yet. */
function stageNext(inst: StageInstance, snap: ItemSnapshot, entry: StageEntry): StageAction {
  const type = stageType(inst.type);
  if (!type?.next)
    return {
      kind: "fail",
      stageId: inst.id,
      reason: `stage type ${inst.type} can't run on the reconciler yet`,
    };
  const steps = snap.steps.filter((s) => s.stageId === entry.stageId && s.round === entry.round);
  const settings = type.settings.parse(inst.settings ?? {});
  const action = type.next({
    settings,
    item: snap.item,
    entry,
    steps,
    observations: snap.observations,
    gate: type.gate(settings),
    failures: failuresOf(snap),
  });
  if (action.kind === "sendBack" && action.to === "")
    return { ...action, to: producerOf(snap.definition, inst) };
  if (action.kind === "sendBack" && action.to === RECHECK)
    return { ...action, to: checkerOf(snap.definition, inst) };
  return action;
}

/** Why a stage is skipped for this item, if it is: its `when`, or its type's own rule. */
function skipReason(inst: StageInstance, snap: ItemSnapshot): string | null {
  const cond = conditionHolds(
    inst.when as Condition | undefined,
    snap.item.size as Size | null,
    snap.item.domains,
  );
  if (!cond.holds) return cond.why;
  const type = stageType(inst.type);
  return type?.skip?.(type.settings.parse(inst.settings ?? {}), snap.item) ?? null;
}

const shapingOf = (def: WorkflowDefinition) =>
  JSON.stringify(def.stages.filter((s) => s.phase === "shaping"));

/**
 * A newer workflow version, between stages (the owner's answers). Before the item has entered a
 * delivery stage, once released: the current version when its shaping stages are unchanged, else a
 * person chooses (Q4). After that: a tightening or neutral change reaches it (Q3); a loosening never
 * does, and it carries on under the version it is pinned to.
 */
function versionChange(snap: ItemSnapshot): ReconcileAction | null {
  const latest = snap.latest;
  if (!latest || latest.version === snap.version || !snap.item.released) return null;
  const pinned = snap.definition;
  const delivered = snap.stages.some(
    (e) => pinned.stages.find((s) => s.id === e.stageId)?.phase === "delivery",
  );
  const from = snap.version !== undefined ? `v${snap.version}` : "the pinned version";
  if (!delivered) {
    if (shapingOf(pinned) === shapingOf(latest.definition))
      return {
        kind: "repin",
        version: latest.version,
        reason: `released: the shaping stages are unchanged since ${from}, so it takes v${latest.version} (Q4)`,
      };
    return {
      kind: "flag",
      stageId: null,
      reason: `the workflow's shaping stages changed since it was shaped (${from} → v${latest.version}): a person chooses (Q4)`,
    };
  }
  const impact = workflowImpact(pinned, latest.definition).class;
  if (impact === "loosens") return null;
  return {
    kind: "repin",
    version: latest.version,
    reason: `v${latest.version} ${impact === "tightens" ? "tightens" : "doesn't change"} what ${from} checks, so it reaches this item at a stage boundary (Q3)`,
  };
}

/**
 * The item's next action. Pure: the same snapshot always gives the same answer.
 * - The current stage is the active entry; with none, the stage after the last entry (stages run
 *   in order), or the stage a send-back named (its entry's note is `to:<stage id>`), next round.
 * - Between stages a newer workflow version may apply (Q3, Q4).
 * - A failed attempt past the item's retry limit fails it, counted as today's Workflow counts.
 * - A stage, or a send-back's target, that the definition no longer has flags the item for a
 *   person: it never fails it and never restarts it.
 * - A stage whose condition doesn't hold is skipped; the item waits for release before its first
 *   delivery stage; after the last stage it is done.
 */
export function reconcile(snap: ItemSnapshot): ReconcileAction {
  if (snap.item.cancelled) return { kind: "wait", stageId: null, why: "cancelled" };
  const stages = snap.definition.stages;
  const last = snap.stages.at(-1);
  const gone = (stageId: string, what: string): ReconcileAction => ({
    kind: "flag",
    stageId,
    reason: `${what} is no longer in the workflow${snap.version !== undefined ? ` (v${snap.version})` : ""}: a person decides where the item goes`,
  });
  if (last?.status === "active") {
    const inst = stages.find((s) => s.id === last.stageId);
    if (!inst) return gone(last.stageId, `its current stage, ${last.stageId},`);
    return stageNext(inst, snap, last);
  }
  if (last?.status === "failed")
    return { kind: "fail", stageId: last.stageId, reason: "the stage failed" };
  const moved = versionChange(snap);
  if (moved) return moved;
  let at = 0;
  if (last?.status === "sent_back") {
    const failures = failuresOf(snap);
    if (countsAsFailure(snap.definition, last) && failures > snap.item.retryLimit)
      return {
        kind: "fail",
        stageId: last.stageId,
        reason: `gave up after ${failures} failed attempts`,
      };
    const to = sendBackTarget(last);
    at = stages.findIndex((s) => s.id === to);
    if (at < 0) return gone(last.stageId, `the stage it was sent back to, ${to},`);
  } else if (last) {
    const i = stages.findIndex((s) => s.id === last.stageId);
    if (i < 0) return gone(last.stageId, `the stage it last finished, ${last.stageId},`);
    at = i + 1;
  }
  const inst = stages[at];
  if (!inst) return { kind: "done" };
  if (inst.phase === "delivery" && !snap.item.released)
    return { kind: "wait", stageId: null, why: "release" };
  const why = skipReason(inst, snap);
  if (why) return { kind: "skip", stageId: inst.id, reason: why };
  const round = snap.stages.filter((e) => e.stageId === inst.id).length + 1;
  return { kind: "enter", stageId: inst.id, round };
}

/** A send-back's target, recorded on the sending entry as `to:<stage id>` then the note. */
export function sendBackTarget(entry: StageEntry): string {
  const head = entry.note?.split("\n")[0] ?? "";
  return head.startsWith("to:") ? head.slice(3) : entry.stageId;
}
