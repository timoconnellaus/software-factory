// The app's operation allowlist and its server function's result shape. The operation types and
// OpError are shared with the desktop app (@software-factory/client); every call goes through one
// server function to sf-engine's EngineApi (ADR 0051), which sets the actor from the session.
import type { Json, OpName } from "@software-factory/client/ops";
import type { RefusalCode } from "@software-factory/core";

export * from "@software-factory/client/ops";

/**
 * The only operations the app's server function will forward: the connect pages' lookups and
 * decisions for a runner's, the CLI's, the desktop app's and a phone's sign-in.
 */
export const APP_OPERATIONS = [
  "runner.deviceLookup",
  "runner.approveDevice",
  "runner.denyDevice",
  "cli.deviceLookup",
  "cli.approveDevice",
  "cli.denyDevice",
  "desktop.authLookup",
  "desktop.approveDevice",
  "desktop.denyDevice",
  "mobile.authLookup",
  "mobile.approveDevice",
  "mobile.denyDevice",
] as const satisfies readonly OpName[];

/** What the server function returns: the operation's output, or a refusal. */
export type OpResult<O = Json> =
  | { ok: true; output: O }
  | { ok: false; code: RefusalCode | "unauthenticated"; message: string };
