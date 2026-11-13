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
  // Spec 53: marking a fix as a repair of a red main lets it land while the line is stopped.
  "workItem.markRepair",
]);

/**
 * Operations a desktop may also run through `decide` with a presence proof, but that don't need one
 * for every input: `planning.answer` answers an ordinary planning question with `call`, and a
 * security, privacy or irreversible one with Touch ID (spec 26, ADR 0042 as amended).
 */
export const DECIDE_OPS: ReadonlySet<string> = new Set([...DECISION_OPS, "planning.answer"]);

/** What `call` answers for a gate decision: it must go through `decide`. */
export const refuseDecisionCall = (op: string) => ({
  ok: false as const,
  code: "forbidden",
  error: `${op} is a gate decision: it goes through decide (Touch ID), not call`,
});
