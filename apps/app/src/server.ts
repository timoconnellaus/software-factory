// sf-app's Worker entry: /api/health, /.well-known/assetlinks.json (the phone app's App Links),
// Better Auth under /api/auth/*, the GitHub App's Setup URL (/integrations/github/setup), and
// TanStack Start for every other request (the sign-in and connect pages, and their server
// functions).
import handler from "@tanstack/react-start/server-entry";
import { ASSET_LINKS_PATH, assetLinks } from "./lib/mobile.ts";
import { appEnv } from "./server/app-api.ts";
import { AUTH_BASE_PATH, getAuth } from "./server/auth.ts";
import { GITHUB_SETUP_PATH, handleGitHubSetup } from "./server/github-setup.ts";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true, worker: "sf-app" });
    // The phone app's App Links (ADR 0541): the package and its release certificate.
    if (pathname === ASSET_LINKS_PATH) {
      return Response.json(assetLinks(env.MOBILE_SIGNING_CERTS), {
        headers: { "cache-control": "public, max-age=300" },
      });
    }
    if (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return getAuth(env).handler(request);
    }
    if (pathname === GITHUB_SETUP_PATH) return handleGitHubSetup(appEnv(env), request);
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
