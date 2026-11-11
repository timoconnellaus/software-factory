// The GitHub App's webhook (V1 step 4; ADR 0010, 0037, 0052): POST /webhooks/github, served on
// software-factory.zerobsai.com by a Workers route in front of sf-app (and on sf-engine's own
// domain). Authenticate the delivery, skip one already handled, map it to operations with the
// GitHub connector, invoke them as the `github` intake, then record the delivery. Refusals are
// audited by invoke() and reported in the response; they don't make GitHub redeliver.

import { GITHUB_INTAKE, routeGitHubEvent } from "@software-factory/connector-github";
import { readDelivery } from "@software-factory/connector-webhook";
import { invoke, isOperationError, OperationError } from "@software-factory/core";
import { invokeDeps } from "./deps.ts";
import { secrets } from "./secrets.ts";

export const WEBHOOK_PATH = "/webhooks/github";

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const delivery = await readDelivery(request, secrets(env).GH_APP_WEBHOOK_SECRET);
  if (!delivery.ok) {
    return Response.json({ error: delivery.error }, { status: delivery.status });
  }
  // A redelivery of something already handled is a no-op (reads are not writes; the record is an
  // operation below).
  const seen = await env.DB.prepare(
    "SELECT 1 AS seen FROM core_connector_events WHERE provider = 'github' AND delivery_id = ?",
  )
    .bind(delivery.deliveryId)
    .first();
  if (seen) return Response.json({ ok: true, duplicate: true });

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.body);
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  const routed = routeGitHubEvent(delivery.event, payload, env.GH_APP_SLUG);
  const deps = invokeDeps(env);
  const options = {
    actor: GITHUB_INTAKE,
    origin: { surface: "connector" as const, requestId: delivery.deliveryId },
  };
  const results: { op: string; outcome: string; detail?: unknown }[] = [];
  for (const [i, call] of routed.calls.entries()) {
    try {
      const r = await invoke(deps, call.op, call.input, {
        ...options,
        idempotencyKey: `github:${delivery.deliveryId}:${i}`,
      });
      results.push({ op: call.op, outcome: r.status, detail: r.status === "ok" ? r.output : null });
    } catch (error) {
      if (!isOperationError(error)) throw error; // 500: GitHub shows it failed; redeliver by hand
      results.push({ op: call.op, outcome: error.code, detail: error.message });
    }
  }
  try {
    await invoke(
      deps,
      "connector.receive",
      {
        provider: "github",
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        action: routed.action,
        repo: routed.repo,
      },
      options,
    );
  } catch (error) {
    // A concurrent copy of this delivery recorded it first: fine.
    if (!(error instanceof OperationError && error.code === "conflict")) throw error;
  }
  return Response.json({ ok: true, event: delivery.event, ignored: routed.ignored, results });
}
