// The operations the front ends call (sf-app and the desktop app), typed from their zod schemas in
// packages/core (types only: nothing from core runs in a view). How a call travels is each app's
// business: sf-app's server functions, or the desktop's main process and the client door.
import type { operations } from "@software-factory/core";
import type { z } from "zod";

type Def<T> = T extends { input: infer I extends z.ZodType; output: infer O extends z.ZodType }
  ? { input: z.input<I>; output: z.output<O> }
  : never;

export interface OpMap {
  "inbox.list": Def<typeof operations.inboxList>;
  "org.list": Def<typeof operations.orgList>;
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
  "workItem.attachment.add": Def<typeof operations.workItemAttachmentAdd>;
  "workItem.attachment.get": Def<typeof operations.workItemAttachmentGet>;
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
  "protection.ruleset": Def<typeof operations.protectionRuleset>;
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

/** JSON as it crosses a process or network boundary (operation outputs are plain JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

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
