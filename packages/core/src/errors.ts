// Typed refusals. `code` is stable and is what callers (the website, the client door, the runner
// channel) branch on. Every refusal past input validation is audited.

export const REFUSAL_CODES = [
  "unknown_operation",
  "invalid_input",
  /** The actor type may not call this operation at all, or a human lacks the permission. */
  "forbidden",
  /** A sign-in a person denied (the phone's sign-in answers it as a refusal, ADR 0541). */
  "denied",
  "conflict",
  "not_found",
  /** Something the operation depends on (a secret, the GitHub App) isn't configured. */
  "unavailable",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class OperationError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

export const isOperationError = (error: unknown): error is OperationError =>
  error instanceof OperationError;

/** The JSON shape of a refusal on any wire (RPC, HTTP). */
export interface Refusal {
  code: RefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

export function toRefusal(error: OperationError): Refusal {
  return {
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}
