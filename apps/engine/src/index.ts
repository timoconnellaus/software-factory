// sf-engine: the signed runner channel, the client door (the desktop app and the `sf` CLI), the
// GitHub App's installation webhook, the new core's MCP server and plugin triggers (spec 70), and
// the minute cron. The website calls the platform's operations through the `EngineApi` RPC
// entrypoint (service binding).

import { runDueSchedules } from "@software-factory/ops";
import { expireRunsWithHooks } from "@software-factory/plugins";
import { pruneRunEvents } from "@software-factory/store";
import { CHANNEL_PREFIX, handleChannel, pruneChannelStore } from "./channel.ts";
import { CLI_PREFIX, CLIENT_PREFIX, handleCli } from "./cli.ts";
import { flowHost } from "./flow/door.ts";
import { handleMcp } from "./flow/mcp.ts";
import { MCP_PATH } from "./flow/mcp-auth.ts";
import { handleTrigger, TRIGGER_PREFIX } from "./flow/triggers.ts";
import { retryOutbox } from "./outbox.ts";
import { pruneExpired } from "./retention.ts";
import { handleGitHubWebhook, WEBHOOK_PATH } from "./webhooks.ts";

export { ClientHub } from "./client-hub.ts";
export { EngineApi } from "./rpc.ts";

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
    // The new core (spec 70 milestone 2): the MCP server a flow run's agent uses (its bearer token
    // names the run), and plugins' public triggers (the plugin's key is the check).
    if (url.pathname === MCP_PATH) return handleMcp(request, env);
    if (url.pathname.startsWith(TRIGGER_PREFIX)) return handleTrigger(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    // Outbox rows whose delivery after commit failed (a device's socket to close, a notification):
    // at most 50 due a tick, through core_outbox_next_idx.
    await retryOutbox(env, now);
    // The new core's runs whose lease lapsed (spec 70): at most 10 a tick, through flow_runs_lease_idx,
    // each with its org's plugins' `runEnded` hooks. Caught, so a failure here never stops the rest
    // of the tick.
    await expireRunsWithHooks(flowHost(env), now.getTime(), 10).catch((error) => {
      console.error("flow expireRuns failed", error);
    });
    // And their events, 30 days after each run finished (AGENTS.md cost rule 3): every minute, at
    // most 4 rounds of 500 rows through flow_runs_events_due_idx; a tick with none due reads none.
    await pruneRunEvents(env.DB, now.getTime()).catch((error) => {
      console.error("flow pruneRunEvents failed", error);
    });
    // The new core's schedules (the Auto screen): at most 20 due a tick, through
    // flow_schedules_due_idx, each moved on to its next time before it makes its item. Caught.
    await runDueSchedules(flowHost(env), now.getTime()).catch((error) => {
      console.error("flow schedules failed", error);
    });
    // The channel's stored answers, and expired sign-in requests and presence challenges.
    await pruneChannelStore(env.DB, now);
    // Once an hour: device codes and GitHub connect states a day past their expiry (rule 3).
    if (now.getUTCMinutes() === 41) await pruneExpired(env.DB, now);
  },
} satisfies ExportedHandler<Env>;
