// The app's operation allowlists and its server function's result shape. The operation types and
// OpError are shared with the desktop app (@software-factory/client); every call goes through one
// server function to sf-engine's EngineApi (ADR 0051), which sets the actor from the session.
import type { Json, OpName } from "@software-factory/client/ops";
import type { RefusalCode } from "@software-factory/core";

export * from "@software-factory/client/ops";

/** The only operations the app's server function will forward. */
export const APP_OPERATIONS = [
  "inbox.list",
  "workItem.create",
  "workItem.previewRouting",
  "workItem.get",
  "workItem.list",
  "workItem.timeline",
  "workItem.cancel",
  "workItem.setWorkflow",
  "workItem.attachPr",
  "workItem.previewAttach",
  "github.openPullRequests",
  "workItem.attachment.list",
  "workItem.attachment.remove",
  "spec.approve",
  "spec.requestChanges",
  "review.merge",
  "review.sendBack",
  "approval.decide",
  "question.answer",
  "question.acceptDefaults",
  "planning.get",
  "planning.presence",
  "planning.move",
  "chat.send",
  "run.live",
  "run.steer",
  "run.takeover",
  "run.reportArchiveMissing",
  "project.create",
  "project.list",
  "project.update",
  "github.connectStart",
  "github.repos",
  "policy.resync",
  "config.get",
  "config.preview",
  "config.save",
  "config.rollback",
  "config.export",
  "config.trials",
  "config.trial.resolve",
  "adjudicator.stats",
  "setup.status",
  "protection.check",
  "runner.deviceLookup",
  "runner.approveDevice",
  "runner.denyDevice",
  "runner.register",
  "runner.rotateKey",
  "runner.list",
  "runner.account.use",
  "cli.deviceLookup",
  "cli.approveDevice",
  "cli.denyDevice",
  "desktop.authLookup",
  "desktop.approveDevice",
  "desktop.denyDevice",
  "desktopDevice.list",
  "desktopDevice.revoke",
  "device.list",
  "device.revoke",
  "mobile.authLookup",
  "mobile.approveDevice",
  "mobile.denyDevice",
  "mobile.pairOffer",
  "mobile.pairOfferStatus",
  "killSwitch.set",
] as const satisfies readonly OpName[];

/** The read operations: what `read()` batches into one server-function call per page load. */
export const APP_READ_OPERATIONS = [
  "inbox.list",
  "workItem.previewRouting",
  "workItem.get",
  "workItem.list",
  "workItem.timeline",
  "workItem.previewAttach",
  "github.openPullRequests",
  "workItem.attachment.list",
  "planning.get",
  "run.live",
  "project.list",
  "github.repos",
  "setup.status",
  "runner.list",
  "desktopDevice.list",
  "device.list",
  "mobile.pairOfferStatus",
  "config.get",
  "config.preview",
  "config.trials",
  "adjudicator.stats",
] as const satisfies readonly OpName[];
export type ReadOpName = (typeof APP_READ_OPERATIONS)[number];

/**
 * Reads that call GitHub (seconds, not milliseconds). They go in a request of their own: a batch
 * answers when its slowest read does, and these would hold up the page's database reads.
 */
export const SLOW_READS: ReadonlySet<ReadOpName> = new Set(["setup.status", "github.repos"]);

/** What the server function returns: the operation's output, a pending gate, or a refusal. */
export type OpResult<O = Json> =
  | { ok: true; status: "ok"; output: O }
  | { ok: true; status: "pending"; pendingActionId: string }
  | { ok: false; code: RefusalCode | "unauthenticated"; message: string };
