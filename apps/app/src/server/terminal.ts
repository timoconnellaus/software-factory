// The Live tab's web terminal (spec 35, ADR 0440): `GET /api/work/<id>/runs/<run>/terminal` is a
// WebSocket to the job's TerminalRelay in sf-engine, opened as the signed-in person. The engine runs
// `run.terminal.attach` (which decides whether they may type and records the attach) and mints a
// one-use viewer ticket; the socket is then opened through the ENGINE binding and handed to the
// browser. Browsers don't apply CORS to WebSockets, so a cross-site page is refused by its Origin.
import type { AppEnv } from "./app-api.ts";
import { userFromRequest } from "./auth.ts";

export const TERMINAL_PATH = /^\/api\/work\/(wi_[0-9a-f]{32})\/runs\/(run_[0-9a-f]{32})\/terminal$/;

/** Whether a WebSocket's Origin is this app (the request's own origin, or its public URL). */
export function sameOrigin(env: Pick<AppEnv, "PUBLIC_BASE_URL">, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin]);
  if (env.PUBLIC_BASE_URL) allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
  return allowed.has(origin);
}

export async function handleTerminal(
  env: AppEnv,
  request: Request,
  workItemId: string,
  runId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response("GET only", { status: 405 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  if (!sameOrigin(env, request)) return new Response("cross-site", { status: 403 });
  const user = await userFromRequest(env, request.headers);
  if (!user) return new Response("Sign in", { status: 401 });
  if (!env.ENGINE.terminalAttach || !env.ENGINE.fetch) {
    return new Response("The web terminal is unavailable", { status: 503 });
  }
  const attached = await env.ENGINE.terminalAttach(workItemId, runId, {
    actor: { type: "human", id: user.id },
    origin: { surface: "app", requestId: crypto.randomUUID() },
  });
  if (!attached.ok) {
    const status =
      attached.error.code === "not_found" || attached.error.code === "forbidden"
        ? 404
        : attached.error.code === "conflict"
          ? 409
          : 503;
    return new Response(attached.error.message, { status });
  }
  // Through the binding: the viewer's socket isn't on sf-engine's public hostname.
  return env.ENGINE.fetch(
    new Request(`https://sf-engine.internal${attached.path}`, {
      headers: { upgrade: "websocket" },
    }),
  );
}
