// sf-engine: one Workflow per work item, the signed runner channel, the GitHub App webhook, outbox
// delivery and the minute cron. sf-app calls operations through the `EngineApi` RPC entrypoint (service binding).
import { GITHUB_INTAKE } from "@software-factory/connector-github";
import {
  FOREMAN,
  invoke,
  isOperationError,
  PROTECTION_RECHECK_MS,
  r2AttachmentBlobs,
  sweepStrayAttachmentBlobs,
} from "@software-factory/core";
import { CHANNEL_PREFIX, handleChannel, pruneChannelStore } from "./channel.ts";
import { CLI_PREFIX, CLIENT_PREFIX, handleCli } from "./cli.ts";
import { invokeDeps } from "./deps.ts";
import { retryOutbox } from "./outbox.ts";
import { handleGitHubWebhook, WEBHOOK_PATH } from "./webhooks.ts";

export { ClientHub } from "./client-hub.ts";
export { PlanningHub } from "./planning-hub.ts";
export { EngineApi } from "./rpc.ts";
export { WorkItemWorkflow } from "./workflow/work-item.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sf-engine" });
    }
    if (url.pathname.startsWith(CHANNEL_PREFIX)) return handleChannel(request, env);
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
