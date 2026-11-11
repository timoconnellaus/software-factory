// The GitHub App's Setup URL (ADR 0055): GitHub sends the person here after they install the App
// (or change its repositories), with `installation_id`, `setup_action` and the `state` Setup put on
// the install link. The engine verifies all of it (github.connectInstallation); this only adds the
// person, and their GitHub user token for an organization's installation, then goes back to Setup.
import type { AppEnv } from "./app-api.ts";
import { getAuth, userFromRequest } from "./auth.ts";
import { invokeAs } from "./engine.ts";

export const GITHUB_SETUP_PATH = "/integrations/github/setup";

const SETUP_ACTIONS = new Set(["install", "update", "request"]);

function back(params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { location: `/setup?${query}`, "cache-control": "no-store" },
  });
}

/**
 * The person's GitHub user token, refreshed by Better Auth if it expired. Only to prove access to
 * an installation on an organization (`GET /user/installations`); never stored by the factory and
 * never used to reach a repo (ADR 0025). Missing is fine: an installation on the person's own
 * account doesn't need it.
 */
async function userToken(
  env: AppEnv,
  headers: Headers,
  userId: string,
): Promise<string | undefined> {
  try {
    // Better Auth's own row for the person's GitHub sign-in (its table, read like sessionInfo does).
    const account = await env.DB.prepare(
      "SELECT id FROM core_account WHERE user_id = ? AND provider_id = 'github' ORDER BY updated_at DESC LIMIT 1",
    )
      .bind(userId)
      .first<{ id: string }>();
    if (!account) return undefined;
    const tokens = await getAuth(env).api.getAccessToken({
      body: { accountId: account.id, userId },
      headers,
    });
    return tokens?.accessToken || undefined;
  } catch {
    return undefined;
  }
}

export async function handleGitHubSetup(env: AppEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const user = await userFromRequest(env, request.headers);
  if (!user) {
    // Back here after signing in, with GitHub's parameters intact.
    return new Response(null, {
      status: 303,
      headers: {
        location: `/sign-in?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      },
    });
  }
  const installationId = url.searchParams.get("installation_id") ?? "";
  const setupAction = url.searchParams.get("setup_action") ?? "install";
  const state = url.searchParams.get("state") ?? undefined;
  if (!/^\d{1,20}$/.test(installationId) || !SETUP_ACTIONS.has(setupAction)) {
    return back({ github_error: "GitHub didn't say which installation to connect. Try again." });
  }
  const token = await userToken(env, request.headers, user.id);
  const result = await invokeAs(env.ENGINE, user.id, "github.connectInstallation", {
    installationId,
    setupAction,
    ...(state ? { state } : {}),
    ...(token ? { userAccessToken: token } : {}),
  });
  if (!result.ok) return back({ github_error: result.message });
  if (result.status !== "ok") return back({ github_error: "held for approval" });
  const output = result.output as {
    outcome: "connected" | "updated" | "requested";
    installation: { account: string } | null;
  };
  return back({
    github: output.outcome,
    ...(output.installation ? { account: output.installation.account } : {}),
  });
}
