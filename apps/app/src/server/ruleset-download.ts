// "Download ruleset" (ADR 0280): GET /api/projects/<projectId>/rulesets/<kind>.json serves the file
// GitHub's New ruleset → Import a ruleset takes, as an attachment named `<repo>-<kind>.json`. The
// engine builds it (`protection.ruleset`) for the signed-in person; nothing here talks to GitHub.
import type { AppEnv } from "./app-api.ts";
import { userFromRequest } from "./auth.ts";
import { invokeAs } from "./engine.ts";

const PATH =
  /^\/api\/projects\/(prj_[0-9a-f]{32})\/rulesets\/(default-branch|factory-branches)\.json$/;

export function matchRulesetDownload(pathname: string) {
  const m = PATH.exec(pathname);
  return m ? { projectId: m[1] as string, kind: m[2] as string } : null;
}

export async function handleRulesetDownload(
  env: AppEnv,
  request: Request,
  target: { projectId: string; kind: string },
): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const user = await userFromRequest(env, request.headers);
  if (!user) return new Response("Sign in to download the ruleset.", { status: 401 });
  const result = await invokeAs(env.ENGINE, user.id, "protection.ruleset", target);
  if (!result.ok) {
    const status = result.code === "not_found" || result.code === "forbidden" ? 404 : 400;
    return new Response(result.message, { status });
  }
  if (result.status !== "ok") return new Response("Not available", { status: 409 });
  const file = result.output as { filename: string; json: string };
  const filename = file.filename.replace(/[^A-Za-z0-9._-]/g, "-");
  return new Response(file.json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
