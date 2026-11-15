// A run as the store hands it out, from its flow_runs row. Shared by runs.ts and chat-runs.ts.
import type { FlowRunRow, RunStatus } from "./schema.ts";

export interface RunResult {
  outcome: "done" | "rejected";
  summary: string;
}

export interface Run {
  id: string;
  orgId: string;
  /** The item the run is on, or null for a chat's run. */
  itemId: string | null;
  /** The chat the run answers, or null for an item's run. */
  chatId: string | null;
  agentId: string;
  /** '' for a chat run. */
  statusId: string;
  /** The item's stay, or the seq of the chat message the run answers. */
  stay: number;
  brief: string;
  status: RunStatus;
  runnerId: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  result: RunResult | null;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  /** The branch the run worked on and the head it handed back; null without a repository. */
  branch: string | null;
  headSha: string | null;
  /** Tool calls the runner reported (run-events.ts). */
  steps: number;
  /** Tokens the runner reported, or null when it reports none. */
  tokens: number | null;
  /** Cost the runner reported, or null (no runner reports cost yet). */
  costUsd: number | null;
}

export function toRun(row: FlowRunRow): Run {
  return {
    id: row.id,
    orgId: row.org_id,
    itemId: row.item_id,
    chatId: row.chat_id,
    agentId: row.agent_id,
    statusId: row.status_id,
    stay: row.stay,
    brief: row.brief,
    status: row.status,
    runnerId: row.runner_id,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result === null ? null : (JSON.parse(row.result) as RunResult),
    error: row.error,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    branch: row.branch ?? null,
    headSha: row.head_sha ?? null,
    steps: row.steps,
    tokens: row.tokens,
    costUsd: row.cost_usd,
  };
}
