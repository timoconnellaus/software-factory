// sf-engine: one Workflow per work item, the signed runner channel, the GitHub App webhook, outbox
// delivery, the minute cron and the runner host's web terminal socket (ADR 0440). sf-app calls operations through the `EngineApi` RPC entrypoint (service binding).
import { GITHUB_INTAKE } from "@software-factory/connector-github";
import {
  FOREMAN,
  invoke,
  isOperationError,
  PROTECTION_RECHECK_MS,
  parseProjectPolicy,
  r2AttachmentBlobs,
  sweepStrayAttachmentBlobs,
} from "@software-factory/core";
import { parseTerminalPath } from "@software-factory/runner-contract";
import { CHANNEL_PREFIX, handleChannel, pruneChannelStore } from "./channel.ts";
import { CLI_PREFIX, CLIENT_PREFIX, handleCli } from "./cli.ts";
import { invokeDeps } from "./deps.ts";
import { retryOutbox } from "./outbox.ts";
import { terminalRelay } from "./terminal-relay.ts";
import { handleGitHubWebhook, WEBHOOK_PATH } from "./webhooks.ts";

export { ClientHub } from "./client-hub.ts";
export { PlanningHub } from "./planning-hub.ts";
export { EngineApi } from "./rpc.ts";
export { TerminalRelay } from "./terminal-relay.ts";
export { WorkItemWorkflow } from "./workflow/work-item.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sf-engine" });
    }
    if (url.pathname.startsWith(CHANNEL_PREFIX)) return handleChannel(request, env);
    // The runner host's web terminal socket (ADR 0440), with the one-use ticket the channel's held
    // `terminal` call gave it. Viewers' sockets are only reachable through EngineApi (the binding).
    const terminal = parseTerminalPath(url.pathname);
    if (terminal?.role === "host") return terminalRelay(env, terminal.jobId).fetch(request);
    if (url.pathname.startsWith(CLI_PREFIX) || url.pathname.startsWith(CLIENT_PREFIX)) {
      return handleCli(request, env);
    }
    if (url.pathname === WEBHOOK_PATH) return handleGitHubWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    await retryOutbox(env, now);
    await expireQuietRuns(env, now);
    await pruneChannelStore(env.DB, now);
    await recheckProtection(env, now);
    await runAdjudicator(env);
    // Once an hour: the improver (ADR 0373) decides running trials and starts the next one.
    if (now.getUTCMinutes() === 23) await runImprover(env, now);
    // Once an hour: attachment blobs whose upload never got its row (ADR 0310).
    if (now.getUTCMinutes() === 17) {
      await sweepStrayAttachmentBlobs(env.DB, r2AttachmentBlobs(env.ATTACHMENTS), now);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Runs whose lease expired (the runner stopped heartbeating) are failed through `run.expire`, which
 * bumps the fencing token and wakes the Workflow (ADR 0035).
 */
export async function expireQuietRuns(env: Env, now: Date): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT r.job_id FROM core_runs r JOIN core_leases l ON l.work_item_id = r.work_item_id AND l.holder_id = r.id
     WHERE r.status IN ('claimed', 'preparing', 'running', 'collecting') AND l.expires_at < ? LIMIT 50`,
  )
    .bind(now.toISOString())
    .all<{ job_id: string }>();
  for (const { job_id } of results) {
    try {
      await invoke(
        invokeDeps(env),
        "run.expire",
        { jobId: job_id, reason: "lease expired: no heartbeat" },
        {
          actor: FOREMAN,
          origin: { surface: "cron" },
        },
      );
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`expire ${job_id}: ${error.code} ${error.message}`);
    }
  }
  return results.length;
}

/**
 * The daily re-check of each project's default-branch protection (ADR 0280), a few projects a
 * minute: drift the webhooks missed (an org ruleset, an event the App isn't subscribed to) still
 * turns Setup red. Runs as the GitHub intake, like a webhook would.
 */
export async function recheckProtection(env: Env, now: Date, limit = 5): Promise<number> {
  const before = new Date(now.getTime() - PROTECTION_RECHECK_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT p.repo_owner, p.repo_name FROM core_projects p
     LEFT JOIN core_project_protection x ON x.project_id = p.id
     WHERE p.installation_record_id IS NOT NULL AND (x.checked_at IS NULL OR x.checked_at < ?)
     ORDER BY x.checked_at LIMIT ?`,
  )
    .bind(before, limit)
    .all<{ repo_owner: string; repo_name: string }>();
  for (const p of results) {
    try {
      await invoke(
        invokeDeps(env),
        "protection.observe",
        { repo: { owner: p.repo_owner, name: p.repo_name }, event: "daily", action: "recheck" },
        { actor: GITHUB_INTAKE, origin: { surface: "cron" } },
      );
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`protection ${p.repo_owner}/${p.repo_name}: ${error.code} ${error.message}`);
    }
  }
  return results.length;
}

/** The improver's actor (ADR 0373): a practice change is its own, never a person's. */
export const IMPROVER = { type: "self-improve" as const, id: "improver" };

/**
 * One improver pass (ADR 0373, spec 09 M3) over projects with self-improvement on: resolve each
 * running trial (promote, disable or keep waiting), then start the drafted practice change, if
 * any. A step the gate holds for review becomes an inbox approval for a person.
 */
export async function runImprover(env: Env, _now?: Date): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, pp.raw FROM core_projects p
     JOIN core_project_policies pp ON pp.project_id = p.id AND pp.sha = p.policy_sha
     WHERE pp.valid = 1 AND pp.raw LIKE '%"improve"%'`,
  ).all<{ id: string; raw: string }>();
  const deps = invokeDeps(env);
  const opts = { actor: IMPROVER, origin: { surface: "cron" as const } };
  let acted = 0;
  for (const p of results) {
    const parsed = parseProjectPolicy(p.raw);
    if (!parsed.ok || !parsed.policy.improve.enabled) continue;
    try {
      const scan = (await invoke(deps, "improve.scan", { projectId: p.id }, opts)) as {
        status: string;
        output?: {
          running: { id: string }[];
          candidate: { kind: string; summary: string; evidence: unknown; policy: unknown } | null;
          baseVersion: number;
        };
      };
      for (const t of scan.output?.running ?? []) {
        await invoke(deps, "config.trial.resolve", { projectId: p.id, trialId: t.id }, opts);
        acted++;
      }
      const c = scan.output?.candidate;
      if (c && scan.output) {
        await invoke(
          deps,
          "config.trial.start",
          {
            projectId: p.id,
            baseVersion: scan.output.baseVersion,
            kind: c.kind,
            summary: c.summary,
            evidence: c.evidence,
            policy: c.policy,
          },
          { ...opts, idempotencyKey: `improver:${p.id}:${scan.output.baseVersion}:${c.summary}` },
        );
        acted++;
      }
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`improver ${p.id}: ${error.code} ${error.message}`);
    }
  }
  return acted;
}

/**
 * The adjudicator's minute (ADR 0374, spec 09 M4): ask it about new open spec gates and gate steps
 * in projects that enable it, then record the verdicts of its finished jobs (approving, in active
 * mode, when it has earned it). A few of each per tick.
 */
export async function runAdjudicator(env: Env, limit = 10): Promise<number> {
  const deps = invokeDeps(env);
  const opts = { actor: IMPROVER, origin: { surface: "cron" as const } };
  const asks = await env.DB.prepare(
    `SELECT pa.id FROM core_pending_actions pa
     JOIN core_projects p ON p.id = pa.project_id
     JOIN core_project_policies pp ON pp.project_id = p.id AND pp.sha = p.policy_sha
     LEFT JOIN core_adjudications a ON a.pending_action_id = pa.id
     WHERE pa.status = 'pending' AND a.id IS NULL AND pa.work_item_id IS NOT NULL
       AND ((pa.kind = 'spec' AND pa.operation = 'spec.accept') OR pa.operation = 'workflow.gate')
       AND pp.raw LIKE '%"adjudicator"%'
     ORDER BY pa.created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  const verdicts = await env.DB.prepare(
    `SELECT a.pending_action_id AS id FROM core_adjudications a
     JOIN core_jobs j ON j.id = a.job_id
     WHERE a.verdict IS NULL AND (j.status IN ('done', 'failed', 'cancelled')
       OR EXISTS (SELECT 1 FROM core_runs r WHERE r.job_id = j.id AND r.status IN ('handed_back', 'failed', 'cancelled')))
     ORDER BY a.created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let n = 0;
  for (const [op, rows] of [
    ["adjudicator.request", asks.results],
    ["adjudicator.record", verdicts.results],
  ] as const) {
    for (const { id } of rows) {
      try {
        await invoke(deps, op, { pendingActionId: id }, opts);
        n++;
      } catch (error) {
        if (!isOperationError(error)) throw error;
        console.warn(`${op} ${id}: ${error.code} ${error.message}`);
      }
    }
  }
  return n;
}
