// Shadow mode (spec 52 PR (c), ADR 0511 §7): the reconciler runs beside today's Workflow and drives
// nothing. Once an item has ended, the engine's shadow pass reads what the Workflow already wrote
// (its stage rows, its jobs and their results, its gates and who decided them) and replays it
// through `reconcile()` in time order: before each thing the Workflow did, it asks what the
// reconciler would have done from the same history, compares the two, then applies what the
// Workflow did, so one difference doesn't cascade. Pure; the engine loads and stores, off the
// Workflow's path.
//
// Compared (`SHADOW_REQUIRED`, all of it): each stage entered, skipped and finished; each job and
// its attempt; each gate opened, and who decided it; each send-back and where it went (so rounds
// follow); retries, through when the reconciler would give up; slot steps, as the small stages they
// are in the definition; and the end of every item, Done or not.
import type { JobStage } from "@software-factory/runner-contract";
import { slotStepId } from "./compile.ts";
import {
  type ItemSnapshot,
  type Observations,
  type ReconcileAction,
  reconcile,
  type StageEntry,
  type StepAttempt,
} from "./reconcile.ts";
import { stageType } from "./registry.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/** Everything the comparison must cover before the agreement streak means anything (spec 52 Q14). */
export const SHADOW_REQUIRED = [
  "stage order and skips",
  "jobs and attempts",
  "gates opened and decided, and by whom",
  "send-back targets and rounds",
  "retry counts",
  "slot steps",
  "the end of every item (failed, rejected, cancelled and incomplete, not only Done)",
] as const;
export type ShadowAspect = (typeof SHADOW_REQUIRED)[number];

/** What `shadowVerdict` compares: all of it. */
export const SHADOW_COMPARED: readonly ShadowAspect[] = [...SHADOW_REQUIRED];

/** What it doesn't yet: nothing, so `reconcile.streak` reports a number. */
export const SHADOW_NOT_COMPARED: readonly ShadowAspect[] = SHADOW_REQUIRED.filter(
  (a) => !SHADOW_COMPARED.includes(a),
);

/**
 * Differences between today's Workflow and the reconciler that are known and not settled. Each is
 * reported under its own name and counts as a divergence, so no item with one extends the streak.
 */
export const KNOWN_DIFFERENCES = {
  /**
   * Before the babysitter (Workflow v4 to v10, ADR 0330): the merge queue merged the default branch
   * in and landed with the same approval, with nothing proving the change was the one approved.
   * The reconciler holds an approval only on the head it was given for, or on a head the
   * babysitter proved carries the approved change (spec 53, ADR 0581/0582): that is settled for v11
   * and later, which is what the switch-over replaces. Older items keep this name.
   */
  "queue-head-moved":
    "the head moved in the merge queue before the babysitter: today's Workflow landed with the same approval unproven; the reconciler would go back to Checks and reopen the gate",
} as const;
export type KnownDifference = keyof typeof KNOWN_DIFFERENCES;

/** What the shadow pass observed about an item besides its history. */
export interface ShadowObserved {
  /** The merge queue brought the head up to date (a review packet carried to the new head). */
  queueHeadMoved?: boolean;
  /** The babysitter delivered it (Workflow v11+): a carried approval was proven (spec 53). */
  babysitter?: boolean;
  /** The project's adjudicator modes (ADR 0374): whether its runs on a gate kind were expected. */
  adjudicator?: { spec: string; step: string; merge?: string };
  /** The plan's kept designs were written back with it (spec 22): not modelled. */
  keptDesigns?: boolean;
  /** Shaped before release (ADR 0493): delivery waited for this time, the pull. */
  releasedAt?: string | null;
  /** A release flag is still on the item (Q4). */
  releaseFlag?: boolean;
}

/**
 * What a run or a gate the reconciler doesn't model, or an event it has no point for, means for the
 * item: an entry in `uncompared`, so it never counts toward the streak (nothing dropped silently).
 */
export const NOT_MODELLED = {
  gate: (operation: string) => `a gate the reconciler doesn't model: ${operation}`,
  repin: "a re-pin to a tightened org version mid-flight (Q3): compared against one definition",
  releaseChoice: "a person's release choice (Q4)",
  releaseFlag: "a release flag (Q4)",
  question:
    "questions put to a person (triage readiness, a slot's ask, the checks-failed question)",
  parked: "parked for its requester (triage readiness, spec 23)",
  keptDesigns: "the plan's kept designs written back with it (spec 22)",
  noPacket: "a verify outcome with no review packet to read the verdict from",
} as const;

/**
 * Today's history records a row the definition has no stage for (an attached PR's skipped spec and
 * build): the reconciler does nothing there, which is the same. Reported by name, not a divergence.
 */
export const EQUIVALENCES = {
  "absent-stage-skipped":
    "today's history records a skip for a stage this workflow doesn't have; the reconciler does nothing there",
} as const;

/** What the switch-over needs the streak to have seen agree at least once (the coordinator's list). */
export const COVERAGE = [
  "a verify that fails",
  "a slot step's send-back",
  "a send-back at the merge gate",
  "retries past the limit",
  "a spec gate with changes requested",
  "a parked item or one with questions",
  "a cancel",
  "an approval the babysitter carried",
  "an attached PR",
  "an incident",
] as const;
export type Coverage = (typeof COVERAGE)[number];

/** A `core_stages` row. */
export interface StageRow {
  stage: string;
  status: "active" | "done" | "skipped" | "sent_back" | "failed" | "cancelled";
  /** When it started and ended (ISO); absent in older callers, which then keep the row order. */
  at?: string;
  endedAt?: string | null;
}

/** A `core_jobs` row, with what its run reported. */
export interface JobRow {
  stage: JobStage;
  role: string;
  /** The slot step it ran (`context.step.id`), if any. */
  step: string | null;
  /** The spec critic's run (`context.specId`): not a step of the stage. */
  critic: boolean;
  /** The adjudicator's run (`context.adjudicate`): not a step of the stage. */
  adjudicate: boolean;
  /** The gate kind the adjudicator was asked about (`context.adjudicate.kind`). */
  adjudicateKind?: string | null;
  status: "queued" | "claimed" | "done" | "failed" | "cancelled";
  at: string;
  endedAt: string | null;
  /** A slot work step's verdict and notes (`core_runs.result`). */
  verdict?: string | null;
  note?: string | null;
}

/** A `core_pending_actions` row on the item. */
export interface GateRow {
  kind: "spec" | "merge" | "approval";
  operation: string;
  /** `workflow.gate`'s step id. */
  step: string | null;
  status: string;
  decision: string | null;
  at: string;
  decidedAt: string | null;
  /** Decided by a person (a user), not the adjudicator or the factory. */
  byPerson: boolean;
  /** The head a merge gate was opened on. */
  headSha: string | null;
  note: string | null;
  /** Who decided it (`decided_by`). */
  decidedBy?: string | null;
  /** The adjudicator's record on it (ADR 0374): its mode then, and whether it decided it. */
  adjudication?: { mode: string; acted: boolean } | null;
}

/** A review packet on the item (`core_review_packets`). */
export interface PacketRow {
  headSha: string;
  verdict: "pass" | "fail";
  at: string;
}

/** Audit events with no point of their own in the replay. */
export interface EventRow {
  kind: "repin" | "releaseChoice" | "question" | "parked";
  at: string;
}

export interface ShadowHistory {
  stages: readonly StageRow[];
  jobs?: readonly JobRow[];
  gates?: readonly GateRow[];
  packets?: readonly PacketRow[];
  events?: readonly EventRow[];
}

/** How the item ended (`core_work_items.status` once closed). */
export type ItemEnd = "done" | "failed" | "rejected" | "cancelled";

export interface ShadowComparison {
  observed: string;
  predicted: string;
  agrees: boolean;
}

export interface ShadowVerdict {
  transitions: ShadowComparison[];
  /** Aspects not compared for this item; each counts as a divergence. Empty now. */
  uncompared: string[];
  /** Known differences this item hit, by name (`KNOWN_DIFFERENCES`); each counts as a divergence. */
  known: { reason: KnownDifference; note: string }[];
  /** Named equivalences it relied on (`EQUIVALENCES`): reported, not divergences. */
  equivalences?: { reason: keyof typeof EQUIVALENCES; note: string }[];
  /** The scenarios this item exercised (`COVERAGE`): the streak's coverage, when it agreed. */
  covers?: Coverage[];
  /** Transitions that disagree, plus every uncompared aspect and known difference. */
  divergences: number;
}

/** The stages today's history records as stages: the definition without its slot steps. */
export function shadowDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return { ...def, stages: def.stages.filter((s) => !stageType(s.type)?.small) };
}

function said(a: ReconcileAction): string {
  switch (a.kind) {
    case "enter":
    case "skip":
    case "complete":
      return `${a.kind} ${a.stageId}`;
    case "job":
    case "gate":
      return `${a.kind} ${a.stageId} ${a.stepId}`;
    case "operation":
      return `operation ${a.stepId}`;
    case "sendBack":
      return `sendBack ${a.stageId} → ${a.to}`;
    case "done":
      return "end done";
    case "fail":
      return "end failed";
    case "reject":
      return "end rejected";
    case "wait":
      return a.why === "cancelled" ? "end cancelled" : `wait ${a.why}`;
    case "repin":
      return `repin v${a.version}`;
    case "flag":
      return `flag ${a.stageId ?? "-"}`;
    default:
      return "unknown";
  }
}

type Point =
  | { t: string; pri: number; kind: "enter" | "skip"; stage: string }
  | { t: string; pri: number; kind: "close"; stage: string; status: StageRow["status"] }
  | { t: string; pri: number; kind: "job"; stage: string; step: string; job: JobRow }
  | { t: string; pri: number; kind: "jobEnd"; stage: string; step: string; job: JobRow }
  | { t: string; pri: number; kind: "gate"; stage: string; step: string; gate: GateRow }
  | { t: string; pri: number; kind: "decided"; stage: string; step: string; gate: GateRow }
  | { t: string; pri: number; kind: "release" };

/** Where a job sits in the definition: its stage and the type's step id, or null (not a step). */
function jobPlace(
  def: WorkflowDefinition,
  job: JobRow,
  slotOf: (step: string) => string | null,
): { stage: string; step: string } | null {
  if (job.critic || job.adjudicate) return null;
  if (job.stage === "triage") return { stage: "triage", step: "triage" };
  if (job.stage === "planning" || job.stage === "spec") return { stage: "spec", step: "session" };
  if (job.stage === "build") return { stage: "build", step: "build" };
  if (job.stage === "verify") {
    if (job.step) {
      const stage = slotOf(job.step);
      return stage ? { stage, step: "check" } : null;
    }
    return def.stages.some((s) => s.id === "verify") ? { stage: "verify", step: "verify" } : null;
  }
  return null;
}

/** Where a gate sits: the spec gate, the merge gate, or a slot decision step. */
function gatePlace(
  gate: GateRow,
  slotOf: (step: string) => string | null,
): { stage: string; step: string } | null {
  if (gate.kind === "spec" && gate.operation === "spec.accept")
    return { stage: "spec", step: "spec-gate" };
  if (gate.kind === "merge") return { stage: "merge", step: "gate" };
  if (gate.operation === "workflow.gate" && gate.step) {
    const stage = slotOf(gate.step);
    return stage ? { stage, step: "decision" } : null;
  }
  return null;
}

/** A gate row's outcome as a step status. */
function gateStatus(gate: GateRow): StepAttempt["status"] {
  const d = gate.decision ?? gate.status;
  if (d === "approved" || d === "applied") return "approved";
  if (d === "rejected") return "rejected";
  if (d === "changes_requested") return "changes_requested";
  if (d === "sent_back") return "sent_back";
  return "pending";
}

/**
 * An ended item's history replayed through the reconciler. At each thing the Workflow did, what the
 * reconciler would have done from the same history; then the Workflow's own move is applied.
 */
export function shadowVerdict(
  definition: WorkflowDefinition,
  item: ItemSnapshot["item"],
  history: ShadowHistory | readonly StageRow[],
  end: ItemEnd,
  observed: ShadowObserved = {},
): ShadowVerdict {
  const h: ShadowHistory = Array.isArray(history)
    ? { stages: history as readonly StageRow[] }
    : (history as ShadowHistory);
  const def = definition;
  const has = (id: string) => def.stages.some((s) => s.id === id);
  const small = (id: string) => {
    const s = def.stages.find((x) => x.id === id);
    return !!s && !!stageType(s.type)?.small;
  };
  const slotOf = (step: string) =>
    def.stages.find((s) => stageType(s.type)?.small && slotStepId(s.id) === step)?.id ?? null;

  // Every row and event as points in time. On a tie, a stage closes before the next one opens, and
  // a step's start before its end.
  const points: Point[] = [];
  // Nothing is dropped silently: what the replay has no point for is named here, and the item then
  // doesn't count toward the streak; what it treats as the same is named in `equivalences`.
  const uncompared = new Set<string>(SHADOW_NOT_COMPARED);
  const equivalences: NonNullable<ShadowVerdict["equivalences"]> = [];
  const transitions: ShadowComparison[] = [];
  const spec = def.stages.find((s) => s.type === "interview-planning");
  const specSettings = spec
    ? (stageType(spec.type)?.settings.safeParse(spec.settings ?? {}).data as
        | { critic?: boolean }
        | undefined)
    : undefined;
  h.stages.forEach((r, i) => {
    if (r.stage === "intake" || r.stage === "done" || r.status === "cancelled") return;
    const t = r.at ?? String(i).padStart(8, "0");
    if (r.status !== "skipped" && !has(r.stage)) {
      uncompared.add(`a stage the workflow doesn't have: ${r.stage}`);
      return;
    }
    if (r.status === "skipped") {
      points.push({ t, pri: 1, kind: "skip", stage: r.stage });
      return;
    }
    points.push({ t, pri: 1, kind: "enter", stage: r.stage });
    if (r.status === "done" || r.status === "sent_back" || r.status === "failed")
      points.push({
        t: r.endedAt ?? h.stages[i + 1]?.at ?? String(i + 1).padStart(8, "0"),
        pri: 0,
        kind: "close",
        stage: r.stage,
        status: r.status,
      });
  });
  for (const job of h.jobs ?? []) {
    if (job.status === "cancelled") continue; // not an attempt, as today's retries don't count it
    if (job.critic) {
      // The spec critic (spec 23 part C) runs when the spec stage's `critic` setting is on.
      const want = specSettings?.critic === true;
      transitions.push({
        observed: "spec critic ran",
        predicted: want ? "spec critic ran" : "no spec critic (the setting is off)",
        agrees: want,
      });
      continue;
    }
    if (job.adjudicate) {
      // The adjudicator is asked only where the project has it on for that gate kind (ADR 0374).
      const kind = job.adjudicateKind ?? "?";
      const mode = (observed.adjudicator as Record<string, string> | undefined)?.[kind] ?? "off";
      transitions.push({
        observed: `adjudicator asked (${kind})`,
        predicted: mode !== "off" ? `adjudicator asked (${kind})` : `no adjudicator for ${kind}`,
        agrees: mode !== "off",
      });
      continue;
    }
    const at = jobPlace(def, job, slotOf);
    if (!at || !has(at.stage)) {
      uncompared.add(
        `a ${job.stage} job for a step the workflow doesn't have${job.step ? ` (${job.step})` : ""}`,
      );
      continue;
    }
    points.push({ t: job.at, pri: 2, kind: "job", ...at, job });
    if ((job.status === "done" || job.status === "failed") && job.endedAt)
      points.push({ t: job.endedAt, pri: 4, kind: "jobEnd", ...at, job });
  }
  for (const gate of h.gates ?? []) {
    const at = gatePlace(gate, slotOf);
    if (!at || !has(at.stage)) {
      uncompared.add(NOT_MODELLED.gate(gate.operation));
      continue;
    }
    points.push({ t: gate.at, pri: 3, kind: "gate", ...at, gate });
    if (gate.decidedAt) points.push({ t: gate.decidedAt, pri: 5, kind: "decided", ...at, gate });
  }
  for (const e of h.events ?? []) uncompared.add(NOT_MODELLED[e.kind]);
  if (observed.keptDesigns) uncompared.add(NOT_MODELLED.keptDesigns);
  if (observed.releaseFlag) uncompared.add(NOT_MODELLED.releaseFlag);
  // A shaped item waits for its release before delivery (ADR 0493): a point of its own.
  let released = observed.releasedAt ? false : item.released;
  if (observed.releasedAt) points.push({ t: observed.releasedAt, pri: 0.5, kind: "release" });
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.pri - b.pri));

  const entries: StageEntry[] = [];
  const steps: StepAttempt[] = [];
  const obs: Observations = {};
  let cancelled = false;
  /** When each entry started, and the time of the point being replayed: to find its packet. */
  const startedAt = new Map<StageEntry, string>();
  let now = "";
  const snap = (): ItemSnapshot => ({
    item: { ...item, released, cancelled },
    definition: def,
    stages: entries,
    steps,
    observations: obs,
  });
  const predict = () => reconcile(snap());
  const compare = (seen: string, p: ReconcileAction | string = predict()) => {
    const predicted = typeof p === "string" ? p : said(p);
    transitions.push({ observed: seen, predicted, agrees: predicted === seen });
    return p;
  };
  const active = () => {
    const last = entries.at(-1);
    return last?.status === "active" ? last : null;
  };
  const inEntry = (e: StageEntry) =>
    steps.filter((s) => s.stageId === e.stageId && s.round === e.round);
  const lastStep = (e: StageEntry, stepId: string) =>
    inEntry(e)
      .filter((s) => s.stepId === stepId)
      .at(-1);
  /** How today's history closed an entry (`core_stages.status`), keyed by the entry. */
  const closedAs = new Map<StageEntry, StageRow["status"]>();
  const gateOpenedAs = new Map<StepAttempt, boolean>();

  /** What the active entry's outcome was: finished, or sent back. */
  const outcomeOf = (e: StageEntry): "done" | "sentBack" => {
    const row = closedAs.get(e);
    if (row === "sent_back" || row === "failed") return "sentBack";
    const type = def.stages.find((s) => s.id === e.stageId)?.type;
    if (type === "agent-check")
      return lastStep(e, "check")?.output?.verdict === "sendBack" ? "sentBack" : "done";
    if (type === "decision") {
      const g = lastStep(e, "decision")?.status;
      return g === "changes_requested" || g === "sent_back" ? "sentBack" : "done";
    }
    return "done";
  };

  /**
   * The checks stage reads CI and the verify run's failures. Both come from the review packet's
   * verdict (`assemblePacket`, packages/core/src/verify/packet.ts), the function the reconciler's
   * checks stage reads at the switch-over: the stored verdict of the packet on this round, never
   * the Workflow's own outcome, so a Workflow that moved on against its packet diverges.
   */
  const observeChecks = (e: StageEntry, outcome: boolean) => {
    if (def.stages.find((s) => s.id === e.stageId)?.type !== "checks") return;
    const from = startedAt.get(e) ?? "";
    const packet = (h.packets ?? []).filter((x) => x.at >= from && x.at <= (now || x.at)).at(-1);
    if (!packet) uncompared.add(NOT_MODELLED.noPacket);
    const passed = packet ? packet.verdict === "pass" : outcome;
    obs.ci = passed ? "pass" : "fail";
    const v = lastStep(e, "verify");
    if (v) v.output = { ...v.output, failures: passed ? [] : ["today's verdict: not passed"] };
  };

  /** Closes the active entry because the Workflow moved on to `next`. */
  const closeActive = (next: string | null) => {
    const e = active();
    if (!e) return;
    const outcome = outcomeOf(e);
    observeChecks(e, outcome === "done");
    const type = def.stages.find((s) => s.id === e.stageId)?.type;
    if (outcome === "sentBack" && type === "publish") {
      // An approval that no longer holds (the babysitter withdrew it, ADR 0582): the head moved.
      const g = lastStep(e, "gate");
      if (g?.status === "approved") obs.headSha = `moved:${g.headSha ?? ""}`;
    }
    if (outcome === "done") {
      compare(`complete ${e.stageId}`);
      e.status = "done";
      return;
    }
    const target = next ?? e.stageId;
    const p = compare(`sendBack ${e.stageId} → ${target}`);
    e.status = "sent_back";
    e.note = `to:${target}`;
    e.free = typeof p !== "string" && p.kind === "sendBack" ? p.free === true : type === "publish";
  };

  /**
   * Before the Workflow acts at `stage`: close what it left, and account for the slot stages it
   * passed by (a slot step whose condition didn't hold runs nothing today).
   */
  const reach = (stage: string, implicitEnter: boolean) => {
    const a = active();
    if (a && a.stageId === stage) return;
    if (a) closeActive(stage);
    for (let guard = 0; guard < def.stages.length; guard++) {
      const p = predict();
      if ((p.kind === "skip" || p.kind === "enter") && p.stageId !== stage && small(p.stageId)) {
        // Nothing ran for that slot step: today skipped it.
        compare(`skip ${p.stageId}`, p);
        entries.push({ stageId: p.stageId, round: 1, typeVersion: 1, status: "skipped" });
        continue;
      }
      break;
    }
    if (implicitEnter) {
      const round = entries.filter((x) => x.stageId === stage).length + 1;
      compare(`enter ${stage}`);
      const entry: StageEntry = { stageId: stage, round, typeVersion: 1, status: "active" };
      entries.push(entry);
      startedAt.set(entry, now);
    }
  };

  for (const pt of points) {
    now = pt.t;
    switch (pt.kind) {
      case "release": {
        // Before it the reconciler waits for the release; after it, delivery runs.
        if (!active()) compare("wait release");
        released = true;
        break;
      }
      case "close": {
        const a = active();
        if (a && a.stageId === pt.stage) closedAs.set(a, pt.status);
        break;
      }
      case "enter": {
        const a = active();
        if (a && a.stageId === pt.stage) {
          // Today's retry opens a new row for the same stage; the reconciler retries in its entry.
          closedAs.delete(a);
          break;
        }
        if (!has(pt.stage)) break;
        reach(pt.stage, true);
        break;
      }
      case "skip": {
        if (!has(pt.stage)) {
          // A skip of a stage the definition doesn't have (an attached PR's spec and build): the
          // reconciler does nothing there, which is the same thing.
          if (!equivalences.some((x) => x.reason === "absent-stage-skipped"))
            equivalences.push({
              reason: "absent-stage-skipped",
              note: EQUIVALENCES["absent-stage-skipped"],
            });
          transitions.push({
            observed: `skip ${pt.stage}`,
            predicted: `nothing (${def.name} has no ${pt.stage} stage)`,
            agrees: true,
          });
          break;
        }
        reach(pt.stage, false);
        compare(`skip ${pt.stage}`);
        entries.push({ stageId: pt.stage, round: 1, typeVersion: 1, status: "skipped" });
        break;
      }
      case "job": {
        reach(pt.stage, small(pt.stage) && active()?.stageId !== pt.stage);
        const e = active();
        if (!e || e.stageId !== pt.stage) {
          transitions.push({
            observed: `job ${pt.stage} ${pt.step}`,
            predicted: said(predict()),
            agrees: false,
          });
          break;
        }
        const attempt = inEntry(e).filter((s) => s.stepId === pt.step).length + 1;
        compare(`job ${pt.stage} ${pt.step}`);
        steps.push({
          stageId: e.stageId,
          round: e.round,
          stepId: pt.step,
          attempt,
          status: "running",
        });
        break;
      }
      case "jobEnd": {
        const e = entries.filter((x) => x.stageId === pt.stage).at(-1);
        const s = e
          ? [...steps]
              .reverse()
              .find(
                (x) =>
                  x.stageId === e.stageId &&
                  x.round === e.round &&
                  x.stepId === pt.step &&
                  x.status === "running",
              )
          : undefined;
        if (!s || !e) break;
        s.status = pt.job.status === "done" ? "ok" : "failed";
        const verdict = pt.job.verdict;
        if (
          pt.step === "check" &&
          (verdict === "pass" || verdict === "sendBack" || verdict === "ask")
        )
          s.output = { verdict, ...(pt.job.note ? { note: pt.job.note } : {}) };
        if (s.status === "ok" && verdict === "ask" && active() === e) {
          // Today asks the agent's questions and goes on once they're answered: the ask gate.
          compare(`gate ${e.stageId} ask`);
          steps.push({
            stageId: e.stageId,
            round: e.round,
            stepId: "ask",
            attempt: 1,
            status: "approved",
          });
        }
        break;
      }
      case "gate": {
        reach(pt.stage, small(pt.stage) && active()?.stageId !== pt.stage);
        const e = active();
        if (!e || e.stageId !== pt.stage) {
          transitions.push({
            observed: `gate ${pt.stage} ${pt.step}`,
            predicted: said(predict()),
            agrees: false,
          });
          break;
        }
        if (pt.stage === "spec") {
          // The planning session waits at its own gate (spec 20): its turn ends when it asks.
          for (const s of inEntry(e))
            if (s.stepId === "session" && s.status === "running") s.status = "ok";
          // Changes requested go back to the same live session, not a new job: its next turn.
          const prior = inEntry(e).at(-1);
          if (prior?.stepId === "spec-gate" && prior.status === "changes_requested") {
            compare("job spec session");
            steps.push({
              stageId: e.stageId,
              round: e.round,
              stepId: "session",
              attempt: inEntry(e).filter((s) => s.stepId === "session").length + 1,
              status: "ok",
            });
          }
        }
        const p = compare(`gate ${pt.stage} ${pt.step}`);
        const step: StepAttempt = {
          stageId: e.stageId,
          round: e.round,
          stepId: pt.step,
          attempt: inEntry(e).filter((s) => s.stepId === pt.step).length + 1,
          status: "pending",
          ...(pt.gate.headSha ? { headSha: pt.gate.headSha } : {}),
        };
        steps.push(step);
        gateOpenedAs.set(step, typeof p !== "string" && p.kind === "gate" && p.alwaysReview);
        break;
      }
      case "decided": {
        const e = entries.filter((x) => x.stageId === pt.stage).at(-1);
        const s = e
          ? [...steps]
              .reverse()
              .find(
                (x) =>
                  x.stageId === e.stageId &&
                  x.round === e.round &&
                  x.stepId === pt.step &&
                  x.status === "pending",
              )
          : undefined;
        if (!s) break;
        s.status = gateStatus(pt.gate);
        if (pt.gate.note) s.output = { note: pt.gate.note };
        const person = gateOpenedAs.get(s) === true;
        // A gate whose type says a person decides (`alwaysReview`) must have been decided by one;
        // any other may also be decided by the adjudicator, only where it had earned it: active for
        // that gate kind, and acting on it (ADR 0374, which acts only once it is eligible).
        const a = pt.gate.adjudication;
        const earned =
          !pt.gate.byPerson &&
          pt.gate.decidedBy === "improver" &&
          !!a?.acted &&
          a.mode === "active";
        const by = pt.gate.byPerson
          ? "a person"
          : earned
            ? "the adjudicator, having earned it"
            : `the factory (${pt.gate.decidedBy ?? "unknown"})`;
        transitions.push({
          observed: `${pt.stage} ${pt.step} decided by ${by}`,
          predicted: `${pt.stage} ${pt.step} decided by ${person ? "a person" : "a person or the adjudicator, having earned it"}`,
          agrees: pt.gate.byPerson || (!person && earned),
        });
        break;
      }
    }
  }

  // The end.
  const known: ShadowVerdict["known"] = [];
  if (end === "cancelled") {
    cancelled = true;
    compare("end cancelled");
  } else if (end === "done") {
    const e = active();
    if (e && def.stages.find((s) => s.id === e.stageId)?.type === "publish") {
      const g = lastStep(e, "gate");
      const approved = g?.status === "approved" ? g.headSha : undefined;
      obs.queueTurn = true;
      if (observed.babysitter && (observed.queueHeadMoved || !g)) {
        // The head the babysitter landed isn't the one approved: it proved the approved change
        // unchanged across a clean merge of main (spec 53), or carried the approval from the
        // round before to a head that passed its own verification (v12): no new gate.
        obs.headSha = `carried:${approved ?? obs.headSha ?? ""}`;
        obs.carriedApproval = { headSha: obs.headSha };
      } else if (observed.queueHeadMoved) {
        // Before the babysitter nothing proved it: named, and a divergence.
        known.push({ reason: "queue-head-moved", note: KNOWN_DIFFERENCES["queue-head-moved"] });
        obs.headSha = approved;
      } else obs.headSha = approved;
      const p = compare("operation merge");
      if (typeof p !== "string" && p.kind === "operation")
        steps.push({
          stageId: e.stageId,
          round: e.round,
          stepId: p.stepId,
          attempt: 1,
          status: "ok",
        });
      obs.merged = true;
      closeActive(null);
    } else if (e) closeActive(null);
    compare("end done");
  } else {
    // Failed or rejected: today's last move, and the reconciler's, after what the history closed.
    const e = active();
    if (e) {
      const outcome = outcomeOf(e);
      if (outcome === "sentBack") observeChecks(e, false);
    }
    let p = predict();
    for (let guard = 0; guard < 4 && p.kind === "sendBack"; guard++) {
      const a = active();
      if (!a) break;
      a.status = "sent_back";
      a.note = `to:${p.to}`;
      a.free = p.free === true;
      p = predict();
    }
    compare(`end ${end}`, p);
  }
  const seen = transitions.filter((t) => t.agrees).map((t) => t.observed);
  const covers: Coverage[] = [];
  const cover = (c: Coverage, yes: boolean) => yes && covers.push(c);
  cover(
    "a verify that fails",
    seen.some((x) => /^sendBack verify → /.test(x)),
  );
  cover(
    "a slot step's send-back",
    seen.some((x) => {
      const id = /^sendBack (\S+) → /.exec(x)?.[1];
      return !!id && small(id);
    }),
  );
  cover(
    "a send-back at the merge gate",
    seen.some((x) => /^sendBack merge → build/.test(x)),
  );
  cover(
    "retries past the limit",
    end === "failed" && seen.includes("end failed") && steps.some((x) => x.status === "failed"),
  );
  cover(
    "a spec gate with changes requested",
    (h.gates ?? []).some((g) => g.kind === "spec" && g.decision === "changes_requested"),
  );
  cover(
    "a parked item or one with questions",
    (h.events ?? []).some((e) => e.kind === "parked" || e.kind === "question"),
  );
  cover("a cancel", end === "cancelled");
  cover("an approval the babysitter carried", !!obs.carriedApproval);
  cover("an attached PR", item.kind === "attached");
  cover("an incident", item.kind === "incident");
  const missing = [...uncompared];
  return {
    transitions,
    uncompared: missing,
    known,
    equivalences,
    covers,
    divergences: transitions.filter((t) => !t.agrees).length + missing.length + known.length,
  };
}
