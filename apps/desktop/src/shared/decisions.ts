// The operations a desktop may run only with a presence proof (ADR 0381): browser-only operations
// that take a desktop proof. The view sends them through `decide` (challenge, Touch ID, call), never
// `call`; the main process refuses one that arrives through `call`. test/decisions.test.ts checks
// this list against core's operations.
export const DECISION_OPS: ReadonlySet<string> = new Set(["mobile.pairOffer"]);

/**
 * Every operation a desktop may run through `decide` with a presence proof: DECISION_OPS, and those
 * that take a desktop proof without needing one for every call (`device.update` renames a device
 * through `call`, but turning its approvals on takes Touch ID, ADR 0541).
 */
export const DECIDE_OPS: ReadonlySet<string> = new Set([...DECISION_OPS, "device.update"]);

/** What `call` answers for an operation that needs a presence proof: it must go through `decide`. */
export const refuseDecisionCall = (op: string) => ({
  ok: false as const,
  code: "forbidden",
  error: `${op} needs a presence proof: it goes through decide (Touch ID), not call`,
});
