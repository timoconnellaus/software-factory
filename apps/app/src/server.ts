// sf-app's Worker entry: /api/health, Better Auth under /api/auth/*, the GitHub App's Setup URL
// (/integrations/github/setup), attachment upload and serving (/api/work/<id>/attachments,
// /api/attachments/<id>), ruleset downloads (/api/projects/<id>/rulesets/<kind>.json, ADR 0280),
// and TanStack Start for every other request (pages and server
// functions).
import handler from "@tanstack/react-start/server-entry";
import { appEnv } from "./server/app-api.ts";
import { routeAttachments } from "./server/attachments.ts";
import { AUTH_BASE_PATH, getAuth } from "./server/auth.ts";
import { GITHUB_SETUP_PATH, handleGitHubSetup } from "./server/github-setup.ts";
import { handleRulesetDownload, matchRulesetDownload } from "./server/ruleset-download.ts";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true, worker: "sf-app" });
    if (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return getAuth(env).handler(request);
    }
    if (pathname === GITHUB_SETUP_PATH) return handleGitHubSetup(appEnv(env), request);
    const attachment = routeAttachments(appEnv(env), request);
    if (attachment) return attachment;
    const ruleset = matchRulesetDownload(pathname);
    if (ruleset) return handleRulesetDownload(appEnv(env), request, ruleset);
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
