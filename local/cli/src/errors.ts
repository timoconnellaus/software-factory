/**
 * An error the CLI prints as `code: message` and exits non-zero on. Server errors keep the engine's
 * `code` (invalid_input, unauthenticated, forbidden, denied, not_found, conflict, unavailable, …)
 * and HTTP status; local ones use their own codes (usage, config, unreachable, …).
 */
export class CliError extends Error {
  override name = "CliError";
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;
  /** An extra line printed after the error: what to do about it. */
  hint: string | null = null;

  constructor(code: string, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** A mistake in how the command was typed: exit 2, as most CLIs do. */
export const usage = (message: string) => new CliError("usage", message);
