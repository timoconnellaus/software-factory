// The operations registry (ADR 0003): every operation, defined once. Adding one here makes it
// available to every surface (the engine RPC the app calls, the runner channel, MCP later).
import { OperationError } from "./errors.ts";
import type { AnyOperation } from "./operation.ts";
import * as attach from "./operations/attach.ts";
import * as connector from "./operations/connector.ts";
import * as devices from "./operations/devices.ts";
import * as gates from "./operations/gates.ts";
import * as github from "./operations/github.ts";
import * as incidents from "./operations/incidents.ts";
import * as onboarding from "./operations/onboarding.ts";
import * as projects from "./operations/projects.ts";
import * as protection from "./operations/protection.ts";
import * as questions from "./operations/questions.ts";
import * as runners from "./operations/runners.ts";
import * as specs from "./operations/specs.ts";
import * as verify from "./operations/verify.ts";
import * as workItems from "./operations/work-items.ts";

export const OPERATIONS: readonly AnyOperation[] = [
  projects.projectCreate,
  projects.projectList,
  projects.projectUpdate,
  projects.policySync,
  projects.killSwitchSet,
  onboarding.githubConnectStart,
  onboarding.githubConnectInstallation,
  onboarding.githubRepos,
  onboarding.policyResync,
  onboarding.policyProposeTemplate,
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
  workItems.workItemEnterStage,
  workItems.workItemFinish,
  attach.workItemAttachPr,
  attach.workItemPreviewAttach,
  attach.workItemAwaitHead,
  attach.githubOpenPullRequests,
  workItems.inboxList,
  questions.questionAsk,
  questions.workItemAwaitQuestions,
  questions.questionAnswer,
  questions.questionAcceptDefaults,
  questions.questionEscalate,
  specs.specPropose,
  specs.specAccept,
  specs.specCommit,
  gates.approvalDecide,
  gates.specApprove,
  gates.specRequestChanges,
  gates.reviewMerge,
  gates.reviewSendBack,
  gates.gateEscalate,
  github.branchEnsure,
  github.branchAdvance,
  github.prOpen,
  github.prMerge,
  verify.reviewPacketRecord,
  verify.ciRead,
  verify.verifyRefresh,
  verify.prAutoMerge,
  verify.projectCheckGitHub,
  connector.connectorReceive,
  connector.pushObserve,
  connector.githubInstallation,
  incidents.incidentOpen,
  runners.runnerRegister,
  runners.runnerRotateKey,
  runners.runnerList,
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
  runners.runAddArtifact,
  runners.runHandBack,
  runners.runRelease,
  runners.runExpire,
  runners.leaseClaim,
  runners.leaseHeartbeat,
  runners.leaseRelease,
  runners.workItemPreviewRouting,
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
  }));
}
