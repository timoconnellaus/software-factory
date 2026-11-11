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
  "workItem.attachment.list": Def<typeof operations.workItemAttachmentList>;
  "workItem.attachment.remove": Def<typeof operations.workItemAttachmentRemove>;
  "spec.approve": Def<typeof operations.specApprove>;
  "spec.requestChanges": Def<typeof operations.specRequestChanges>;
  "review.merge": Def<typeof operations.reviewMerge>;
  "review.sendBack": Def<typeof operations.reviewSendBack>;
  "approval.decide": Def<typeof operations.approvalDecide>;
  "question.answer": Def<typeof operations.questionAnswer>;
  "question.acceptDefaults": Def<typeof operations.questionAcceptDefaults>;
  "project.create": Def<typeof operations.projectCreate>;
  "project.list": Def<typeof operations.projectList>;
  "project.update": Def<typeof operations.projectUpdate>;
  "github.connectStart": Def<typeof operations.githubConnectStart>;
  "github.repos": Def<typeof operations.githubRepos>;
  "policy.resync": Def<typeof operations.policyResync>;
  "policy.proposeTemplate": Def<typeof operations.policyProposeTemplate>;
  "setup.status": Def<typeof operations.setupStatus>;
  "runner.deviceLookup": Def<typeof operations.runnerDeviceLookup>;
  "runner.approveDevice": Def<typeof operations.runnerApproveDevice>;
  "runner.denyDevice": Def<typeof operations.runnerDenyDevice>;
  "runner.register": Def<typeof operations.runnerRegister>;
  "runner.rotateKey": Def<typeof operations.runnerRotateKey>;
  "runner.list": Def<typeof operations.runnerList>;
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
  "workItem.attachment.list",
  "workItem.attachment.remove",
  "spec.approve",
  "spec.requestChanges",
  "review.merge",
  "review.sendBack",
  "approval.decide",
  "question.answer",
  "question.acceptDefaults",
  "project.create",
  "project.list",
  "project.update",
  "github.connectStart",
  "github.repos",
  "policy.resync",
  "policy.proposeTemplate",
  "setup.status",
  "runner.deviceLookup",
  "runner.approveDevice",
  "runner.denyDevice",
  "runner.register",
  "runner.rotateKey",
  "runner.list",
  "killSwitch.set",
] as const satisfies readonly OpName[];

/** The read operations: what `read()` batches into one server-function call per page load. */
export const APP_READ_OPERATIONS = [
  "inbox.list",
  "workItem.previewRouting",
  "workItem.get",
  "workItem.list",
  "workItem.timeline",
  "workItem.attachment.list",
  "project.list",
  "github.repos",
  "setup.status",
  "runner.list",
] as const satisfies readonly OpName[];
export type ReadOpName = (typeof APP_READ_OPERATIONS)[number];

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
