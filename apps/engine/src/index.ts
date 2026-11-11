// sf-engine: one Workflow per work item, the signed runner channel, the GitHub App webhook, outbox
// delivery and the minute cron. sf-app calls operations through the `EngineApi` RPC entrypoint (service binding).
import { FOREMAN, invoke, isOperationError } from "@software-factory/core";
import { CHANNEL_PREFIX, handleChannel, pruneChannelStore } from "./channel.ts";
import { invokeDeps } from "./deps.ts";
import { retryOutbox } from "./outbox.ts";
import { handleGitHubWebhook, WEBHOOK_PATH } from "./webhooks.ts";

export { EngineApi } from "./rpc.ts";
export { WorkItemWorkflow } from "./workflow/work-item.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sf-engine" });
    }
    if (url.pathname.startsWith(CHANNEL_PREFIX)) return handleChannel(request, env);
    if (url.pathname === WEBHOOK_PATH) return handleGitHubWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    await retryOutbox(env, now);
    await expireQuietRuns(env, now);
    await pruneChannelStore(env.DB, now);
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
