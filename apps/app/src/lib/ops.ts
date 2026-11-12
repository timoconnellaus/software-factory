// The operations the dashboard calls, typed from their zod schemas in packages/core (types only:
// nothing from core runs in the browser). Every call goes through one server function to
// sf-engine's EngineApi (ADR 0051); the server sets the actor from the signed-in session.
import type { operations, RefusalCode } from "@software-factory/core";
import type { z } from "zod";

type Def<T> = T extends { input: infer I extends z.ZodType; output: infer O extends z.ZodType }
  ? { input: z.input<I>; output: z.output<O> }
  : never;

export interface OpMap {
  "inbox.list": Def<typeof operations.inboxList>;
  "workItem.create": Def<typeof operations.workItemCreate>;
  "workItem.previewRouting": Def<typeof operations.workItemPreviewRouting>;
  "workItem.get": Def<typeof operations.workItemGet>;
  "workItem.list": Def<typeof operations.workItemList>;
  "workItem.timeline": Def<typeof operations.workItemTimeline>;
  "workItem.cancel": Def<typeof operations.workItemCancel>;
  "workItem.setWorkflow": Def<typeof operations.workItemSetWorkflow>;
  "workItem.attachPr": Def<typeof operations.workItemAttachPr>;
  "workItem.previewAttach": Def<typeof operations.workItemPreviewAttach>;
  "github.openPullRequests": Def<typeof operations.githubOpenPullRequests>;
  "workItem.attachment.list": Def<typeof operations.workItemAttachmentList>;
  "workItem.attachment.remove": Def<typeof operations.workItemAttachmentRemove>;
  "spec.approve": Def<typeof operations.specApprove>;
  "spec.requestChanges": Def<typeof operations.specRequestChanges>;
  "review.merge": Def<typeof operations.reviewMerge>;
  "review.sendBack": Def<typeof operations.reviewSendBack>;
  "approval.decide": Def<typeof operations.approvalDecide>;
  "question.answer": Def<typeof operations.questionAnswer>;
  "question.acceptDefaults": Def<typeof operations.questionAcceptDefaults>;
  "planning.get": Def<typeof operations.planningGet>;
  "planning.presence": Def<typeof operations.planningPresence>;
  "planning.move": Def<typeof operations.planningMove>;
  "chat.send": Def<typeof operations.chatSend>;
  "run.live": Def<typeof operations.runLive>;
  "run.steer": Def<typeof operations.runSteer>;
  "run.takeover": Def<typeof operations.runTakeover>;
  "project.create": Def<typeof operations.projectCreate>;
  "project.list": Def<typeof operations.projectList>;
  "project.update": Def<typeof operations.projectUpdate>;
  "github.connectStart": Def<typeof operations.githubConnectStart>;
  "github.repos": Def<typeof operations.githubRepos>;
  "policy.resync": Def<typeof operations.policyResync>;
  "config.get": Def<typeof operations.configGet>;
  "config.preview": Def<typeof operations.configPreview>;
  "config.save": Def<typeof operations.configSave>;
  "config.rollback": Def<typeof operations.configRollback>;
  "config.export": Def<typeof operations.configExport>;
  "config.trials": Def<typeof operations.configTrials>;
  "config.trial.resolve": Def<typeof operations.configTrialResolve>;
  "adjudicator.stats": Def<typeof operations.adjudicatorStatsOp>;
  "setup.status": Def<typeof operations.setupStatus>;
  "protection.check": Def<typeof operations.protectionCheck>;
  "runner.deviceLookup": Def<typeof operations.runnerDeviceLookup>;
  "runner.approveDevice": Def<typeof operations.runnerApproveDevice>;
  "runner.denyDevice": Def<typeof operations.runnerDenyDevice>;
  "runner.register": Def<typeof operations.runnerRegister>;
  "runner.rotateKey": Def<typeof operations.runnerRotateKey>;
  "runner.list": Def<typeof operations.runnerList>;
  "cli.deviceLookup": Def<typeof operations.cliDeviceLookup>;
  "cli.approveDevice": Def<typeof operations.cliApproveDevice>;
  "cli.denyDevice": Def<typeof operations.cliDenyDevice>;
  "desktop.authLookup": Def<typeof operations.desktopAuthLookup>;
  "desktop.approveDevice": Def<typeof operations.desktopApproveDevice>;
  "desktop.denyDevice": Def<typeof operations.desktopDenyDevice>;
  "desktopDevice.list": Def<typeof operations.desktopDeviceList>;
  "desktopDevice.revoke": Def<typeof operations.desktopDeviceRevoke>;
  "killSwitch.set": Def<typeof operations.killSwitchSet>;
}

export type OpName = keyof OpMap;
export type OpInput<N extends OpName> = OpMap[N]["input"];
export type OpOutput<N extends OpName> = OpMap[N]["output"];

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
  "cli.deviceLookup",
  "cli.approveDevice",
  "cli.denyDevice",
  "desktop.authLookup",
  "desktop.approveDevice",
  "desktop.denyDevice",
  "desktopDevice.list",
  "desktopDevice.revoke",
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

/** JSON as it crosses the server-function boundary (operation outputs are plain JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What the server function returns: the operation's output, a pending gate, or a refusal. */
export type OpResult<O = Json> =
  | { ok: true; status: "ok"; output: O }
  | { ok: true; status: "pending"; pendingActionId: string }
  | { ok: false; code: RefusalCode | "unauthenticated"; message: string };

/** A refusal surfaced to UI code as an error, with its stable code. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export type WorkItemDetail = OpOutput<"workItem.get">;
export type Inbox = OpOutput<"inbox.list">;
export type Attachment = OpOutput<"workItem.attachment.list">["attachments"][number];
export type TimelineEntry = OpOutput<"workItem.timeline">["entries"][number];
export type Project = OpOutput<"project.list">["projects"][number];
export type SetupStatus = OpOutput<"setup.status">;
export type RepoChoice = OpOutput<"github.repos">["repos"][number];
export type OpenPull = OpOutput<"github.openPullRequests">["pulls"][number];
export type ConfigView = OpOutput<"config.get">;
export type LiveView = OpOutput<"run.live">;
export type LiveEvent = LiveView["events"][number];
export type LiveSteer = LiveView["steers"][number];
