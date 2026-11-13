// The operations registry (ADR 0003): every operation, defined once. Adding one here makes it
// available to every surface (the engine RPC the app calls, the runner channel, MCP later).
import { OperationError } from "./errors.ts";
import type { AnyOperation } from "./operation.ts";
import * as adjudicator from "./operations/adjudicator.ts";
import * as adopt from "./operations/adopt.ts";
import * as artifacts from "./operations/artifacts.ts";
import * as attach from "./operations/attach.ts";
import * as attachments from "./operations/attachments.ts";
import * as audit from "./operations/audit.ts";
import * as babysit from "./operations/babysit.ts";
import * as backlog from "./operations/backlog.ts";
import * as cli from "./operations/cli.ts";
import * as config from "./operations/config.ts";
import * as connector from "./operations/connector.ts";
import * as delivery from "./operations/delivery.ts";
import * as desktop from "./operations/desktop.ts";
import * as device from "./operations/device.ts";
import * as devices from "./operations/devices.ts";
import * as gates from "./operations/gates.ts";
import * as github from "./operations/github.ts";
import * as improve from "./operations/improve.ts";
import * as incidents from "./operations/incidents.ts";
import * as live from "./operations/live.ts";
import * as mergeQueue from "./operations/merge-queue.ts";
import * as mobile from "./operations/mobile.ts";
import * as onboarding from "./operations/onboarding.ts";
import * as planning from "./operations/planning.ts";
import * as projects from "./operations/projects.ts";
import * as protection from "./operations/protection.ts";
import * as questions from "./operations/questions.ts";
import * as reconcile from "./operations/reconcile.ts";
import * as revert from "./operations/revert.ts";
import * as runners from "./operations/runners.ts";
import * as skills from "./operations/skills.ts";
import * as specs from "./operations/specs.ts";
import * as terminal from "./operations/terminal.ts";
import * as verify from "./operations/verify.ts";
import * as workItems from "./operations/work-items.ts";
import * as workflows from "./operations/workflows.ts";

export const OPERATIONS: readonly AnyOperation[] = [
  projects.projectCreate,
  projects.projectList,
  projects.orgList,
  projects.projectUpdate,
  projects.repositoryAdd,
  projects.repositoryList,
  projects.repositoryUpdate,
  backlog.workItemRelease,
  backlog.workItemShape,
  backlog.workItemReleaseChoice,
  backlog.workItemRepinWorkflow,
  backlog.workItemShaped,
  backlog.workItemParkForInfo,
  backlog.workItemMove,
  backlog.workItemUpdate,
  backlog.workItemReorder,
  backlog.workItemLink,
  backlog.workItemUnlink,
  backlog.workItemBoard,
  backlog.projectWorkflow,
  backlog.queuePull,
  projects.policySync,
  projects.killSwitchSet,
  projects.killSwitchList,
  config.configGet,
  config.configPreview,
  config.configSave,
  config.configRollback,
  config.configExport,
  config.overrideApprove,
  improve.improveScan,
  improve.configTrialStart,
  improve.configTrialResolve,
  improve.configTrials,
  adjudicator.adjudicatorRequest,
  adjudicator.adjudicatorRecord,
  skills.skillList,
  skills.skillGet,
  skills.skillSave,
  skills.skillAttach,
  skills.skillDetach,
  skills.skillArchive,
  skills.skillPropose,
  skills.skillAccept,
  skills.skillReject,
  skills.skillForJob,
  adjudicator.adjudicatorStatsOp,
  onboarding.githubConnectStart,
  onboarding.githubConnectInstallation,
  onboarding.githubRepos,
  onboarding.policyResync,
  onboarding.setupStatus,
  protection.protectionRuleset,
  protection.protectionCheck,
  protection.protectionObserve,
  workItems.workItemCreate,
  workItems.workItemList,
  workItems.workItemGet,
  workItems.workItemTimeline,
  workItems.workItemCancel,
  workItems.workItemTriage,
  workItems.workItemSetWorkflow,
  workItems.workflowGate,
  workItems.workflowRecord,
  workItems.workItemEnterStage,
  workItems.workItemFinish,
  attach.workItemAttachPr,
  attach.workItemPreviewAttach,
  attach.workItemAwaitHead,
  attach.githubOpenPullRequests,
  workItems.inboxList,
  attachments.workItemAttachmentAdd,
  attachments.workItemAttachmentList,
  attachments.workItemAttachmentGet,
  attachments.workItemAttachmentRemove,
  questions.questionAsk,
  questions.planningSeedQuestions,
  questions.workItemAwaitQuestions,
  questions.questionAnswer,
  questions.questionAcceptDefaults,
  questions.planningAnswer,
  questions.planningAcceptDefaults,
  questions.planningFinishAlone,
  questions.questionAnswerFromEdit,
  questions.questionEscalate,
  questions.questionUpdate,
  questions.questionDelete,
  questions.questionReorder,
  questions.questionFocus,
  planning.planningStart,
  planning.planningAwaitReady,
  planning.planningNote,
  planning.planningEnd,
  planning.specRevise,
  planning.chatReply,
  planning.planningNews,
  planning.planningPeek,
  planning.specEdit,
  artifacts.artifactAdd,
  artifacts.artifactUpdate,
  artifacts.artifactDelete,
  artifacts.artifactShow,
  artifacts.artifactGet,
  artifacts.artifactRead,
  artifacts.designPull,
  artifacts.designPreview,
  planning.specReleaseEdit,
  planning.planningWait,
  planning.planningYield,
  planning.planningReady,
  planning.chatSend,
  planning.planningPresence,
  planning.planningMove,
  planning.planningStop,
  planning.planningPause,
  planning.planningResume,
  planning.planningGet,
  planning.specCritique,
  planning.planningRequestYield,
  specs.specPropose,
  specs.specAccept,
  specs.specCommit,
  specs.splitRelease,
  specs.specWriteBack,
  gates.approvalDecide,
  cli.cliDeviceStart,
  cli.cliDevicePoll,
  cli.cliDeviceLookup,
  cli.cliApproveDevice,
  cli.cliDenyDevice,
  cli.cliTokenList,
  cli.cliTokenRevoke,
  desktop.desktopAuthStart,
  desktop.desktopAuthLookup,
  desktop.desktopApproveDevice,
  desktop.desktopDenyDevice,
  desktop.desktopAuthExchange,
  desktop.desktopDeviceList,
  desktop.desktopDeviceRevoke,
  desktop.presenceChallenge,
  desktop.presenceRedeem,
  device.deviceList,
  device.deviceRevoke,
  device.deviceUpdate,
  mobile.mobileNonce,
  mobile.mobileAuthStart,
  mobile.mobileAuthLookup,
  mobile.mobileApproveDevice,
  mobile.mobileDenyDevice,
  mobile.mobileAuthExchange,
  mobile.mobilePairOffer,
  mobile.mobilePairOfferStatus,
  mobile.mobileRenew,
  gates.specApprove,
  gates.specRequestChanges,
  gates.reviewMerge,
  gates.reviewSendBack,
  gates.gateEscalate,
  github.branchEnsure,
  github.branchAdvance,
  github.prOpen,
  github.prMerge,
  mergeQueue.mergeQueueEnter,
  mergeQueue.mergeQueuePosition,
  mergeQueue.mergeQueueList,
  mergeQueue.mergeQueueUpdate,
  mergeQueue.mergeQueueLeave,
  delivery.mainObserve,
  delivery.workItemMarkRepair,
  delivery.deliveryStatus,
  delivery.mainRedAttribute,
  revert.mainRedRevert,
  revert.mainRedReland,
  revert.mainRedCloseRevert,
  mergeQueue.mergeQueueMerging,
  mergeQueue.mergeQueueHold,
  babysit.babysitWake,
  babysit.babysitNext,
  babysit.babysitResolution,
  babysit.babysitResolutionPatches,
  babysit.ciRerun,
  babysit.flakeRecord,
  verify.reviewPacketRecord,
  verify.ciRead,
  verify.checksForHead,
  verify.checksProvable,
  verify.verifyRefresh,
  verify.prAutoMerge,
  verify.projectCheckGitHub,
  connector.connectorReceive,
  connector.pushObserve,
  connector.githubInstallation,
  incidents.incidentOpen,
  audit.auditVerify,
  audit.auditArchiveHealth,
  incidents.incidentListArchiveMissing,
  incidents.incidentResolve,
  runners.runnerRegister,
  runners.runnerRotateKey,
  runners.runnerList,
  runners.runnerAccountUse,
  devices.runnerDeviceStart,
  devices.runnerDevicePoll,
  devices.runnerDeviceLookup,
  devices.runnerApproveDevice,
  devices.runnerDenyDevice,
  runners.runnerHeartbeat,
  runners.jobEnqueue,
  runners.jobClaim,
  runners.runIssueToken,
  runners.runReportEvents,
  live.runLive,
  live.runSteer,
  live.runReportArchiveMissing,
  live.runTakeSteers,
  live.runTakeover,
  terminal.runTerminalAttach,
  terminal.runTerminalDetach,
  terminal.runTerminalHost,
  terminal.runTerminalCloseStale,
  runners.runAddArtifact,
  runners.runHandBack,
  runners.runRelease,
  runners.runExpire,
  runners.leaseClaim,
  runners.leaseHeartbeat,
  runners.leaseRelease,
  runners.workItemPreviewRouting,
  workflows.workflowList,
  workflows.workflowGet,
  workflows.workflowPreview,
  workflows.workflowSave,
  workflows.workflowCreateFromTemplate,
  workflows.workflowArchive,
  workflows.agentSave,
  workflows.orgConfigGet,
  workflows.orgConfigRollback,
  workflows.orgConfigPreviewRollback,
  adopt.orgConfigAdoptProjectWorkflows,
  workflows.stageTypeList,
  reconcile.reconcileReport,
  reconcile.reconcileStreak,
];

const byName = new Map<string, AnyOperation>();
for (const op of OPERATIONS) {
  if (byName.has(op.name))
    throw new OperationError("conflict", `operation ${op.name} is defined twice`);
  byName.set(op.name, op);
}

export function getOperation(name: string): AnyOperation | undefined {
  return byName.get(name);
}

export type OperationName = (typeof OPERATIONS)[number]["name"];

/** What `describe_operations` returns on MCP, and what the app can render as help. */
export function describeOperations() {
  return OPERATIONS.map((op) => ({
    name: op.name,
    description: op.description,
    risk: op.risk,
    actors: [...op.actors],
    permission: op.permission,
    fenced: op.fenced ?? false,
    gateKind: op.gateKind ?? null,
    /** Decided only in the app (ADR 0340); a function means "for some inputs". */
    browserOnly:
      op.browserOnly === undefined ? false : op.browserOnly === true ? true : "some inputs",
  }));
}
