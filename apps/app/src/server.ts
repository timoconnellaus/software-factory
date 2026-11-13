// sf-app's Worker entry: /api/health, /.well-known/assetlinks.json (the phone app's App Links), Better Auth under /api/auth/*, the GitHub App's Setup URL
// (/integrations/github/setup), attachment upload and serving (/api/work/<id>/attachments,
// /api/attachments/<id>), the Live tab's web terminal socket (/api/work/<id>/runs/<run>/terminal, ADR 0440), ruleset downloads (/api/projects/<id>/rulesets/<kind>.json, ADR 0280),
// and TanStack Start for every other request (pages and server
// functions).
import handler from "@tanstack/react-start/server-entry";
import { ASSET_LINKS_PATH, assetLinks } from "./lib/mobile.ts";
import { appEnv } from "./server/app-api.ts";
import { routeAttachments } from "./server/attachments.ts";
import { AUTH_BASE_PATH, getAuth } from "./server/auth.ts";
import { GITHUB_SETUP_PATH, handleGitHubSetup } from "./server/github-setup.ts";
import { handleRulesetDownload, matchRulesetDownload } from "./server/ruleset-download.ts";
import { handleTerminal, TERMINAL_PATH } from "./server/terminal.ts";

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
    const attachment = routeAttachments(appEnv(env), request);
    if (attachment) return attachment;
    const terminal = pathname.match(TERMINAL_PATH);
    if (terminal?.[1] && terminal[2]) {
      return handleTerminal(appEnv(env), request, terminal[1], terminal[2]);
    }
    const ruleset = matchRulesetDownload(pathname);
    if (ruleset) return handleRulesetDownload(appEnv(env), request, ruleset);
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
