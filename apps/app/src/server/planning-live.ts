// The Planning tab's live updates (spec 20, ADR 0350): `GET /api/work/<id>/planning/live` is a
// Server-Sent-Events stream of "something changed" from the work item's PlanningHub in sf-engine,
// proxied as the signed-in person (the engine checks they may read the planning view). The page
// re-reads `planning.get` on each event. No polling.
import type { AppEnv } from "./app-api.ts";
import { userFromRequest } from "./auth.ts";

export const LIVE_PATH = /^\/api\/work\/(wi_[0-9a-f]{32})\/planning\/live$/;

export async function handlePlanningLive(
  env: AppEnv,
  request: Request,
  workItemId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response("GET only", { status: 405 });
  const user = await userFromRequest(env, request.headers);
  if (!user) return new Response("Sign in", { status: 401 });
  if (!env.ENGINE.planningStream) return new Response("Live updates unavailable", { status: 503 });
  const opened = await env.ENGINE.planningStream(workItemId, {
    actor: { type: "human", id: user.id },
    origin: { surface: "app", requestId: crypto.randomUUID() },
  });
  if (!opened.ok) {
    const status =
      opened.error.code === "not_found" || opened.error.code === "forbidden" ? 404 : 503;
    return new Response(opened.error.message, { status });
  }
  return new Response(opened.stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
