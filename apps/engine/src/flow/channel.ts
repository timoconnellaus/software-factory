// The new core's runs on the signed runner channel (spec 70): the same wire paths and signing as the
// old core's jobs. A flow job's id is its flow run's id (`frun_…`), so a job-scoped call, a held job
// in a heartbeat and a claim are told apart by that prefix alone. The old core is never asked about
// a flow job, and a flow job never touches core_jobs, core_runs or core_leases.

import { endRunWithHooks } from "@software-factory/plugins";
import {
  type ChannelReply,
  claimRequestSchema,
  eventsRequestSchema,
  flowResultSchema,
  handbackSchema,
  type Job,
  type JobCall,
  RUNNER_COMPAT,
  releaseRequestSchema,
} from "@software-factory/runner-contract";
import {
  type ClaimedRun,
  chatHistory,
  claimRun,
  endChatRun,
  getItem,
  getProject,
  getRun,
  type Pushed,
  type RunResult,
  recentComments,
  renewLease,
  StoreError,
  storeRunEvents,
} from "@software-factory/store";
import { chatPrompt, PROMPT_CHAT_MESSAGES } from "./chat-prompt.ts";
import { flowHost } from "./door.ts";
import { FLOW_JOB_TOKEN_PERMISSIONS, flowGitHub } from "./github.ts";
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

type Ended =
  | { status: "done"; result: RunResult; pushed?: Pushed }
  | { status: "failed"; error: string; pushed?: Pushed };

/**
 * Ends a run. An item's run goes through the plugin host (`leaving`, the step, `runEnded` and
 * `entered`). A chat's run has no item and no plugins around it: the store marks it and adds the
 * model's reply (its summary, or a plain note that it failed) to the chat.
 */
async function endFlowRun(
  env: Env,
  run: { id: string; chatId: string | null },
  token: number,
  end: Ended,
): Promise<void> {
  if (run.chatId !== null) {
    // A chat's run has no repository, so nothing it pushed.
    await endChatRun(
      env.DB,
      run.id,
      token,
      end.status === "done"
        ? { status: "done", result: end.result }
        : { status: "failed", error: end.error },
    );
  } else {
    await endRunWithHooks(flowHost(env), run.id, token, end);
  }
}

/**
 * Where a run on a project with a repository starts: its item's branch when that already exists on
 * GitHub (a later run continues the earlier run's work), else the default branch. The item's head
 * being set (a run that ended `done` pushed it) is the proof that costs nothing; the first run on
 * the item's branch needs none either. Only a run after one that never handed a head back (it
 * failed, or was rejected without pushing) asks GitHub, once, at its claim.
 */
async function baseRefOf(
  env: Env,
  repo: NonNullable<NonNullable<ClaimedRun["project"]>["repo"]>,
  item: NonNullable<ClaimedRun["item"]> & { branch: string },
): Promise<string> {
  if (item.headSha !== null) return item.branch;
  if (item.firstOnBranch) return repo.defaultBranch;
  try {
    const github = flowGitHub(env);
    const ref = { installationId: repo.installationId, owner: repo.owner, name: repo.name };
    if (github && (await github.branchSha(ref, item.branch)) !== null) return item.branch;
  } catch (error) {
    // GitHub didn't answer: start from the default branch; a push onto an existing branch then
    // fails the run plainly, and a retry asks again.
    console.warn(`flow claim: couldn't read ${item.branch}: ${String(error)}`);
  }
  return repo.defaultBranch;
}

/**
 * The claim, before the old core's job.claim: the oldest queued flow run this runner serves, built
 * as a `flow` job, or null to fall through. Placed as a light job: only with a free light slot (or,
 * for a runner with one pool, a free slot) as the runner reports it, while it accepts work, isn't
 * rate-limited or paused for that pool, and runs code at the engine's compatibility level. A claim
 * signed before the runner's last accepted heartbeat or claim (a replay) gets nothing here.
 *
 * A chat's run always gets the engine's own MCP server ("factory"); an item's run gets it when its
 * agent has it in its `mcp`. The job carries it in `mcpServers`, at `origin`, with a bearer token
 * valid while the run is claimed. The model and effort are the chat's (or the agent's): Claude Code
 * aliases and levels, or nothing for the runner's default.
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
  // A chat's run: the conversation before the message it answers. An item's: its recent comments.
  const prompt =
    run.chatId !== null
      ? chatPrompt(run, await chatHistory(env.DB, run.chatId, run.stay, PROMPT_CHAT_MESSAGES))
      : flowPrompt(run, await recentComments(env.DB, run.itemId ?? "", PROMPT_COMMENTS));
  const factory = run.chatId !== null || Boolean(run.agent?.mcp.includes(FACTORY_MCP));
  const mcpServers = factory
    ? [
        {
          name: FACTORY_MCP,
          url: `${origin}${MCP_PATH}`,
          headers: { Authorization: `Bearer ${await issueMcpToken(env.DB, run.id)}` },
        },
      ]
    : undefined;
  const repo = run.project?.repo ?? null;
  const branch = run.item?.branch ?? null;
  const checkout =
    repo && run.item && branch
      ? {
          repo: {
            url: `https://github.com/${repo.owner}/${repo.name}.git`,
            owner: repo.owner,
            name: repo.name,
            baseRef: await baseRefOf(env, repo, { ...run.item, branch }),
            defaultBranch: repo.defaultBranch,
          },
          branch,
        }
      : null;
  return {
    jobId: run.id,
    runId: run.id,
    runNo: run.stay,
    stage: "flow",
    ...(checkout ?? {}),
    // A chat's run stands for its chat here: the host only names a work item in its run folder.
    workItem: run.item
      ? { id: run.itemId ?? "", number: run.item.number, title: run.item.title }
      : { id: run.chatId ?? "", number: run.stay, title: run.chat?.title ?? "Chat" },
    // Claude Code with the chat's (or agent's) model alias and effort; none: the runner's default.
    harness: {
      id: "claude-code",
      role: "implement",
      prompt,
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
    },
    context:
      run.chatId !== null
        ? { orgId: run.orgId, chatId: run.chatId }
        : { orgId: run.orgId, statusId: run.statusId },
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
 * The `token` call for a claimed flow run on a project with a repository: a fresh installation token
 * for that one repository, `contents: write` only, never stored, with the item's branch as the one
 * branch it may push. A run without a repository has no token.
 */
async function flowJobToken(
  env: Env,
  run: { itemId: string | null; branch: string | null; status: string },
): Promise<ChannelReply> {
  const none = refuse(404, "not_found", "a flow job without a repository has no token");
  if (run.itemId === null || run.branch === null) return none;
  if (run.status !== "claimed") return refuse(409, "fenced", `the flow run is ${run.status}`);
  const item = await getItem(env.DB, run.itemId);
  const repo = item ? (await getProject(env.DB, item.projectId))?.repo : null;
  if (!repo) return none;
  const github = flowGitHub(env);
  if (!github) return refuse(503, "unavailable", "this engine has no GitHub App set up");
  const minted = await github.repoToken(
    { installationId: repo.installationId, owner: repo.owner, name: repo.name },
    FLOW_JOB_TOKEN_PERMISSIONS,
  );
  return {
    body: {
      token: minted.token,
      expiresAt: minted.expiresAt,
      repo: { owner: repo.owner, name: repo.name },
      pushBranch: run.branch,
    },
  };
}

/**
 * A job-scoped call on a flow job. `handback` finishes the run with the agent's result (an invalid
 * or missing one fails it) and, for a run with a repository, its branch and head; `release` after a
 * failure, or with the run still open, fails it; `events` are stored for the run view; `artifacts`
 * are accepted and dropped; `token` mints a run with a repository its push token (flowJobToken);
 * every other call is refused, since a flow job has no steers, terminal or planning. Each checks
 * the run is this runner's and the fencing token is current: a stale one is 409 `fenced`, so the
 * host stops.
 */
export async function flowJobReply(
  env: Env,
  runnerId: string,
  jobId: string,
  call: JobCall,
  body: Record<string, unknown>,
): Promise<ChannelReply> {
  if (!["handback", "release", "events", "artifacts", "token"].includes(call)) {
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
  if (call === "token") return flowJobToken(env, run);
  try {
    // Stored for the run view (packages/store run-events.ts): one D1 batch, no audit row. Accepted
    // after the hand-back too: the host flushes its last events then.
    if (call === "events") {
      const parsed = eventsRequestSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_input", parsed.error.message);
      try {
        await storeRunEvents(env.DB, jobId, parsed.data.events);
      } catch (error) {
        // Two batches raced twice: a 5xx, so the host keeps the batch and sends it again (a 409
        // would stop its job).
        if (error instanceof StoreError && error.code === "conflict") {
          return refuse(503, "unavailable", error.message);
        }
        throw error;
      }
      return { body: { ok: true } };
    }
    // Dropped: a flow job has no repository, so nothing it produces is an artifact yet.
    if (call === "artifacts") return { body: { ok: true } };
    if (call === "release") {
      const parsed = releaseRequestSchema.safeParse({ ...body, jobId });
      if (!parsed.success) return refuse(400, "invalid_input", parsed.error.message);
      // A run that already ended (handed back, failed or cancelled) is released as it is.
      if (open) {
        await endFlowRun(env, run, token, {
          status: "failed",
          error:
            parsed.data.reason?.trim() || "The runner released the job without handing it back.",
        });
      }
      return { body: { released: true } };
    }
    const parsed = handbackSchema.safeParse({ ...body, jobId });
    if (!parsed.success) return refuse(400, "invalid_input", parsed.error.message);
    if (!open) return refuse(409, "fenced", `the flow run is ${run.status}`);
    const handback = parsed.data;
    // What a run with a repository pushed (store: only its own branch counts).
    const pushed: Pushed | undefined =
      run.branch !== null && handback.branch
        ? { branch: handback.branch, headSha: handback.headSha ?? null }
        : undefined;
    const also = pushed ? { pushed } : {};
    if (handback.outcome !== "completed") {
      await endFlowRun(env, run, token, {
        status: "failed",
        error: handback.summary?.trim() || `The run ${handback.outcome}.`,
        ...also,
      });
      return { body: { accepted: true } };
    }
    const result = flowResultSchema.safeParse(handback.result);
    if (!result.success) {
      await endFlowRun(env, run, token, {
        status: "failed",
        error:
          "The agent didn't leave a valid result: it must write { outcome: done | rejected, summary }.",
        ...also,
      });
      return { body: { accepted: true } };
    }
    await endFlowRun(env, run, token, { status: "done", result: result.data, ...also });
    return { body: { accepted: true } };
  } catch (error) {
    if (error instanceof StoreError) {
      // Someone moved the item, or another call ended the run, between the read and the write.
      return refuse(409, error.code === "not_found" ? "not_found" : "fenced", error.message);
    }
    throw error;
  }
}
