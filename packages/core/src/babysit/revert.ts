// The engine-made revert (spec 53 §5, decision 2, ADR 0584): when a red main's culprit is named, the
// factory may ask GitHub to revert its PR. The revert merges without a person only when the
// workflow's own switch is on (off by default) and every condition below holds, in code.
import type { ChangedFile } from "../services.ts";
import type { WorkflowDefinition } from "../stages/workflow.ts";
import { riskFlags } from "../verify/risk.ts";

/** How long an episode is red before a revert is made (spec 53 §5, `revertAfterMinutes`). */
export const REVERT_AFTER_MS = 30 * 60_000;

/**
 * Whether a workflow lets the engine's revert merge without a person: its Publish stage's
 * `revertWithoutPerson`, off by default; turning it on is a loosening only a person saves.
 */
export function revertWithoutPerson(def: WorkflowDefinition | null | undefined): boolean {
  const publish = def?.stages.find((s) => s.type === "publish");
  const settings = publish?.settings as { revertWithoutPerson?: unknown } | undefined;
  return settings?.revertWithoutPerson === true;
}

export interface RevertFacts {
  /** The switch on the revert's workflow. */
  switchOn: boolean;
  /**
   * The PR is the engine's own revert of a suspect of the open episode, unchanged since: computed
   * with `exactInverse()` on the head being merged, at the moment of the verdict, never from the
   * `exact_inverse` recorded when the revert opened (its head can have moved; review of #178).
   */
  engineRevertOfSuspect: boolean;
  /** How long the episode has been red. */
  redForMs: number;
  /** Another repair for the episode is open or merged. */
  otherRepair: boolean;
  /** Checks red on main's head, and CI on the revert's head by name. */
  redOnMain: readonly string[];
  revertCi: ReadonlyMap<string, string | null>;
  /** The revert's changed files. */
  files: readonly ChangedFile[];
}

/**
 * Whether the engine's revert may merge with no person (spec 53 §5's five conditions, decision 2).
 * Every reason it can't is returned; an empty list means it may. `autoApprove` never decides a
 * revert, and this decides nothing else.
 */
export function revertVerdict(f: RevertFacts): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!f.switchOn) reasons.push("the workflow's revertWithoutPerson is off");
  if (!f.engineRevertOfSuspect) reasons.push("it isn't the engine's unchanged revert of a suspect");
  if (f.redForMs < REVERT_AFTER_MS) reasons.push("main hasn't been red for 30 minutes");
  if (f.otherRepair) reasons.push("another repair for this episode is open or merged");
  const unproven = f.redOnMain.filter((c) => f.revertCi.get(c) !== "success");
  if (f.redOnMain.length === 0 || unproven.length > 0) {
    reasons.push(
      `its own CI doesn't show it repairs main (${unproven.join(", ") || "no failing check named"})`,
    );
  }
  if (riskFlags([...f.files]).some((r) => r.kind === "factory-config")) {
    reasons.push("it touches a self-modify path: a person decides");
  }
  return { ok: reasons.length === 0, reasons };
}
