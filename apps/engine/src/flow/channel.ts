// The new core's runs on the signed runner channel (spec 70): the same wire paths and signing as the
// old core's jobs. A flow job's id is its flow run's id (`frun_…`), so a job-scoped call, a held job
// in a heartbeat and a claim are told apart by that prefix alone. The old core is never asked about
// a flow job, and a flow job never touches core_jobs, core_runs or core_leases.

import { endRunWithHooks } from "@software-factory/plugins";
import {
  type ChannelReply,
  claimRequestSchema,
  flowResultSchema,
  handbackSchema,
  type Job,
  type JobCall,
  RUNNER_COMPAT,
  releaseRequestSchema,
} from "@software-factory/runner-contract";
import {
  claimRun,
  getRun,
  type RunResult,
  recentComments,
  renewLease,
  StoreError,
} from "@software-factory/store";
import { flowHost } from "./door.ts";
import { FACTORY_MCP, issueMcpToken, MCP_PATH } from "./mcp-auth.ts";
import { flowPrompt, PROMPT_COMMENTS } from "./prompt.ts";

/** A flow job's id prefix: the flow run's id (packages/store). */
export const FLOW_JOB_PREFIX = "frun_";
/** As the old core's LEASE_TTL_MS: a heartbeat every ~20 s renews it. */
export const FLOW_LEASE_MS = 10 * 60_000;
/** How long a flow run's session may take before the host stops it. */
export const FLOW_SESSION_TIMEOUT_MS = 60 * 60_000;

export const isFlowJob = (jobId: string) => jobId.startsWith(FLOW_JOB_PREFIX);

const refuse = (status: number, code: string, error: string): ChannelReply => ({
  status,
  body: { error, code },
});

/** The run failed: through the plugin host, so the org's `runEnded` hooks run. */
const failRun = (env: Env, runId: string, token: number, error: string) =>
  endRunWithHooks(flowHost(env), runId, token, { status: "failed", error });

/** The agent finished: `leaving`, the step, `runEnded` and `entered`, through the plugin host. */
const finishRun = (env: Env, runId: string, token: number, result: RunResult) =>
  endRunWithHooks(flowHost(env), runId, token, { status: "done", result });

/**
 * The claim, before the old core's job.claim: the oldest queued flow run this runner serves, built
 * as a `flow` job, or null to fall through. Placed as a light job: only with a free light slot (or,
 * for a runner with one pool, a free slot) as the runner reports it, while it accepts work, isn't
 * rate-limited or paused for that pool, and runs code at the engine's compatibility level. A claim
 * signed before the runner's last accepted heartbeat or claim (a replay) gets nothing here.
 *
 * When the run's agent has the engine's own MCP server ("factory" in its `mcp`), the job carries
 * it in `mcpServers`, at `origin`, with a bearer token valid while the run is claimed.
 */
export async function claimFlowJob(
  env: Env,
  runnerId: string,
  body: unknown,
  signedAt: number | undefined,
  origin: string,
  now = Date.now(),
): Promise<Job | null> {
  const parsed = claimRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const { capacity, manifest } = parsed.data;
  if (!capacity.accepting || !manifest.harnesses.includes("claude-code")) return null;
  // Only a host that knows the `flow` stage: an older one would try to clone a repository.
  if (!manifest.capabilities.includes("flow")) return null;
  const paused = capacity.paused?.pools ?? [];
  const room = capacity.light
    ? capacity.light.inUse < capacity.light.max && !paused.includes("light")
    : capacity.inUse < capacity.max && paused.length === 0;
  if (!room) return null;
  const runner = await env.DB.prepare(
    "SELECT rate_limited_until, compat, last_signed_at FROM core_runners WHERE id = ?",
  )
    .bind(runnerId)
    .first<{
      rate_limited_until: string | null;
      compat: number | null;
      last_signed_at: number | null;
    }>();
  if (!runner) return null;
  if (runner.rate_limited_until && Date.parse(runner.rate_limited_until) > now) return null;
  if ((runner.compat ?? 1) < RUNNER_COMPAT) return null;
  if (signedAt !== undefined && runner.last_signed_at !== null && signedAt < runner.last_signed_at)
    return null;

  const run = await claimRun(env.DB, runnerId, now, FLOW_LEASE_MS);
  if (!run) return null;
  const comments = await recentComments(env.DB, run.itemId, PROMPT_COMMENTS);
  const mcpServers = run.agent?.mcp.includes(FACTORY_MCP)
    ? [
        {
          name: FACTORY_MCP,
          url: `${origin}${MCP_PATH}`,
          headers: { Authorization: `Bearer ${await issueMcpToken(env.DB, run.id)}` },
        },
      ]
    : undefined;
  return {
    jobId: run.id,
    runId: run.id,
    runNo: run.stay,
    stage: "flow",
    workItem: { id: run.itemId, number: run.item.number, title: run.item.title },
    // As the old core's light stages: Claude Code, a role, no model named (the harness's default).
    harness: { id: "claude-code", role: "implement", prompt: flowPrompt(run, comments) },
    context: { orgId: run.orgId, statusId: run.statusId },
    requires: [],
    limits: { sessionTimeoutMs: FLOW_SESSION_TIMEOUT_MS },
    lease: { fencingToken: run.fencingToken, expiresAt: run.leaseExpiresAt },
    ...(mcpServers ? { mcpServers } : {}),
  };
}

/**
 * Renews the leases of the flow jobs a heartbeat says it holds. A job this runner no longer holds
 * (the item moved on and its run was cancelled, or the lease lapsed) is cancelled. One guarded
 * UPDATE per held flow job and nothing else: no audit row, nothing written when nothing is held.
 */
export async function beatFlowJobs(
  env: Env,
  runnerId: string,
  held: { jobId: string; fencingToken: number }[],
  now = Date.now(),
): Promise<{
  leases: { jobId: string; expiresAt: string }[];
  commands: { kind: "cancel"; jobId: string; reason: string }[];
}> {
  const leases: { jobId: string; expiresAt: string }[] = [];
  const commands: { kind: "cancel"; jobId: string; reason: string }[] = [];
  const expiresAt = new Date(now + FLOW_LEASE_MS).toISOString();
  for (const job of held) {
    if (await renewLease(env.DB, job.jobId, runnerId, now, FLOW_LEASE_MS)) {
      leases.push({ jobId: job.jobId, expiresAt });
    } else {
      commands.push({ kind: "cancel", jobId: job.jobId, reason: "the flow run is no longer held" });
    }
  }
  return { leases, commands };
}

/**
 * A job-scoped call on a flow job. `handback` finishes the run with the agent's result (an invalid
 * or missing one fails it); `release` after a failure, or with the run still open, fails it;
 * `events` and `artifacts` are accepted and dropped for now; `token` and every other call are
 * refused, since a flow job has no repository, steers, terminal or planning. Each checks the run
 * is this runner's and the fencing token is current: a stale one is 409 `fenced`, so the host stops.
 */
export async function flowJobReply(
  env: Env,
  runnerId: string,
  jobId: string,
  call: JobCall,
  body: Record<string, unknown>,
): Promise<ChannelReply> {
  if (call === "token") {
    return refuse(404, "not_found", "a flow job has no repository, so it has no token");
  }
  if (!["handback", "release", "events", "artifacts"].includes(call)) {
    return refuse(404, "not_found", `a flow job has no ${call} call`);
  }
  const run = await getRun(env.DB, jobId);
  if (!run) return refuse(404, "not_found", `no flow run ${jobId}`);
  if (run.runnerId !== runnerId)
    return refuse(403, "forbidden", "this job belongs to another runner");
  const token = body.fencingToken;
  if (typeof token !== "number" || token !== run.fencingToken) {
    return refuse(409, "fenced", `fencing token ${String(token)} is stale for ${jobId}`);
  }
  const open = run.status === "claimed";
  try {
    // Dropped for now. Accepted after the hand-back too: the host flushes its last events then.
    if (call === "events" || call === "artifacts") return { body: { ok: true } };
    if (call === "release") {
      const parsed = releaseRequestSchema.safeParse({ ...body, jobId });
      if (!parsed.success) return refuse(400, "invalid_input", parsed.error.message);
      // A run that already ended (handed back, failed or cancelled) is released as it is.
      if (open) {
        await failRun(
          env,
          jobId,
          token,
          parsed.data.reason?.trim() || "The runner released the job without handing it back.",
        );
      }
      return { body: { released: true } };
    }
    const parsed = handbackSchema.safeParse({ ...body, jobId });
    if (!parsed.success) return refuse(400, "invalid_input", parsed.error.message);
    if (!open) return refuse(409, "fenced", `the flow run is ${run.status}`);
    const handback = parsed.data;
    if (handback.outcome !== "completed") {
      await failRun(env, jobId, token, handback.summary?.trim() || `The run ${handback.outcome}.`);
      return { body: { accepted: true } };
    }
    const result = flowResultSchema.safeParse(handback.result);
    if (!result.success) {
      await failRun(
        env,
        jobId,
        token,
        "The agent didn't leave a valid result: it must write { outcome: done | rejected, summary }.",
      );
      return { body: { accepted: true } };
    }
    await finishRun(env, jobId, token, result.data);
    return { body: { accepted: true } };
  } catch (error) {
    if (error instanceof StoreError) {
      // Someone moved the item, or another call ended the run, between the read and the write.
      return refuse(409, error.code === "not_found" ? "not_found" : "fenced", error.message);
    }
    throw error;
  }
}
