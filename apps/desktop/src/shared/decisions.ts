// The gate decisions (ADR 0381): the operations a desktop may run only with a presence proof. The
// view sends them through `decide` (challenge, Touch ID, call), never `call`; the main process
// refuses one that arrives through `call`. test/decisions.test.ts checks this list against core's
// `presenceDecidable` operations.
export const DECISION_OPS: ReadonlySet<string> = new Set([
  "spec.approve",
  "spec.requestChanges",
  "review.merge",
  "review.sendBack",
  "approval.decide",
  "question.answer",
  "question.acceptDefaults",
  // Policy decisions on the desktop (ADR 0610): org config writes, an org admin's approval of a
  // looser override, and marking a repair of a red main.
  "workflow.save",
  "workflow.createFromTemplate",
  "workflow.archive",
  "agent.save",
  "orgConfig.rollback",
  "override.approve",
  "workItem.markRepair",
  // Saving or turning on an org autopilot (ADR 0514, review of #197).
  "autopilot.save",
  "autopilot.enable",
]);

/**
 * Operations a desktop may also run through `decide` with a presence proof, but that don't need one
 * for every input: `planning.answer` answers an ordinary planning question with `call`, and a
 * security, privacy or irreversible one with Touch ID (spec 26, ADR 0042 as amended).
 */
export const DECIDE_OPS: ReadonlySet<string> = new Set([
  ...DECISION_OPS,
  "planning.answer",
  // A proof for some inputs only (ADR 0610): turning a kill switch off (on is a plain call), and
  // adopting projects' workflows for real (its dry run is a plain call).
  "killSwitch.set",
  "orgConfig.adoptProjectWorkflows",
]);

/** What `call` answers for a gate decision: it must go through `decide`. */
export const refuseDecisionCall = (op: string) => ({
  ok: false as const,
  code: "forbidden",
  error: `${op} is a gate decision: it goes through decide (Touch ID), not call`,
});
