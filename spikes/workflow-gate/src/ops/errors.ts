// Typed refusals. `code` is stable and is what callers (and the Workflow) branch on.

export type RefusalCode =
  | "unknown_operation"
  | "invalid_input"
  | "forbidden"
  | "denied"
  | "killed"
  | "bad_approval"
  | "conflict"
  | "not_found";

export class OperationError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

export const isOperationError = (error: unknown): error is OperationError =>
  error instanceof OperationError;
