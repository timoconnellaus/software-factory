// The parts of operation outputs the friendly commands print (packages/core/src/operations). The
// CLI doesn't import core: it is a thin client of `/cli/v1`, and `sf call --json` shows the rest.

export interface ItemSummary {
  id: string;
  projectId: string;
  orgId: string;
  number: number;
  title: string;
  kind: string;
  stage: string;
  status: string;
  statusReason: string | null;
  size: string | null;
  source: string;
  branch: string;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemDetail {
  item: ItemSummary & { prNumber: number | null; headSha: string | null };
  stages: { stage: string; attempt: number; status: string; reason: string | null }[];
  questions: { id: string; domain: string; prompt: string; status: string; blocking: boolean }[];
  gates: {
    id: string;
    kind: string;
    operation: string;
    status: string;
    decision: string | null;
    assigneeUserId: string | null;
    createdAt: string;
  }[];
  runs: {
    id: string;
    runNo: number;
    stage: string;
    runnerId: string;
    status: string;
    outcome: string | null;
    summary: string | null;
    takeover: { label: string; hint: string } | null;
    startedAt: string;
    endedAt: string | null;
  }[];
  reviewPacket: {
    headSha: string;
    verdict: "pass" | "fail";
    summary: string;
    riskFlags: string[];
    createdAt: string;
  } | null;
  mergeQueue: { position: number; ahead: number[] } | null;
}

/** A `workItem.timeline` entry, as the endpoint returns it. */
export interface TimelineEntry {
  id: string;
  at: string;
  operation: string;
  actorType: string;
  actorId: string;
  decision: string;
  outcome: string;
  reason: string | null;
  pendingActionId: string | null;
  result: unknown;
}

export interface Inbox {
  gates: {
    id: string;
    kind: string;
    workItemId: string | null;
    projectId: string | null;
    title: string;
    operation: string;
    createdAt: string;
    escalated: boolean;
  }[];
  questions: {
    id: string;
    workItemId: string;
    projectId: string;
    title: string;
    domain: string;
    prompt: string;
  }[];
  running: ItemSummary[];
  runners: { name: string; state: string; inUse: number; max: number }[];
  wipHolds: { projectId: string; waitingBuilds: number }[];
  protection: { name: string; branch: string; problems: string[]; rulesetsUrl: string }[];
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  repo: { owner: string; name: string; defaultBranch: string };
}

export interface QueueEntry {
  workItemId: string;
  number: number;
  title: string;
  headSha: string;
  enqueuedAt: string;
}

export interface Created {
  workItemId: string;
  number: number;
  branch: string;
  outcome: "created" | "attached" | "duplicate";
}
