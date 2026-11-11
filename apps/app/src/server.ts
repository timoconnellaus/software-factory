// sf-app's Worker entry: /api/health, Better Auth under /api/auth/*, the GitHub App's Setup URL
// (/integrations/github/setup), and TanStack Start for every other request (pages and server
// functions).
import handler from "@tanstack/react-start/server-entry";
import { appEnv } from "./server/app-api.ts";
import { AUTH_BASE_PATH, getAuth } from "./server/auth.ts";
import { GITHUB_SETUP_PATH, handleGitHubSetup } from "./server/github-setup.ts";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true, worker: "sf-app" });
    if (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return getAuth(env).handler(request);
    }
    if (pathname === GITHUB_SETUP_PATH) return handleGitHubSetup(appEnv(env), request);
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
