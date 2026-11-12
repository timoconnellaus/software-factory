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
]);

/** What `call` answers for a gate decision: it must go through `decide`. */
export const refuseDecisionCall = (op: string) => ({
  ok: false as const,
  code: "forbidden",
  error: `${op} is a gate decision: it goes through decide (Touch ID), not call`,
});
