// What the server functions do, framework-free so it is tested directly in workerd. fns.ts wraps
// each in a TanStack Start server function; the browser never talks to D1 or sf-engine itself.
import { z } from "zod";
import { APP_OPERATIONS, type OpResult } from "#/lib/ops";
import { type AuthEnv, type SignedInUser, userFromRequest } from "./auth.ts";
import { type EngineRpc, invokeAs } from "./engine.ts";

export interface AppEnv extends AuthEnv {
  ENGINE: EngineRpc;
  PUBLIC_BASE_URL?: string;
}

/** Narrows the generated Env (ENGINE is a plain Service there) to what the server code uses. */
export function appEnv(env: unknown): AppEnv {
  return env as AppEnv;
}

export const opCallSchema = z.object({
  name: z.enum(APP_OPERATIONS),
  input: z.unknown(),
  /** A client-generated key per form submit, so a retried submit runs once. */
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type OpCall = z.infer<typeof opCallSchema>;

const UNAUTHENTICATED: OpResult = {
  ok: false,
  code: "unauthenticated",
  message: "Your session has ended. Sign in again.",
};

export async function runOp(env: AppEnv, headers: Headers, raw: unknown): Promise<OpResult> {
  const call = opCallSchema.safeParse(raw);
  if (!call.success) return { ok: false, code: "invalid_input", message: "unknown operation" };
  const user = await userFromRequest(env, headers);
  if (!user) return UNAUTHENTICATED;
  return invokeAs(env.ENGINE, user.id, call.data.name, call.data.input, call.data.idempotencyKey);
}

export interface SessionInfo {
  user: SignedInUser;
  orgs: { id: string; name: string; kind: string; role: string }[];
  /** The Personal org (every user has one). */
  personalOrgId: string | null;
}

/** The signed-in user and their orgs (Better Auth's tables), or null. */
export async function sessionInfo(env: AppEnv, headers: Headers): Promise<SessionInfo | null> {
  const user = await userFromRequest(env, headers);
  if (!user) return null;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, o.kind, m.role FROM core_member m
     JOIN core_organization o ON o.id = m.organization_id
     WHERE m.user_id = ? ORDER BY o.kind = 'personal' DESC, o.created_at`,
  )
    .bind(user.id)
    .all<{ id: string; name: string; kind: string; role: string }>();
  return {
    user,
    orgs: results,
    personalOrgId: results.find((o) => o.kind === "personal")?.id ?? null,
  };
}

const POLICY_PATH = ".factory/policy.json";

type Fetch = typeof fetch;

/**
 * Reads `.factory/policy.json` from the project's default branch on GitHub and records it with
 * `policy.sync` (until the GitHub connector does this on every push, ADR 0036). The content always
 * comes from GitHub at the branch head, never from the browser.
 */
export async function syncPolicyFromGitHub(
  env: AppEnv,
  headers: Headers,
  projectId: string,
  fetcher: Fetch = fetch,
): Promise<OpResult> {
  const user = await userFromRequest(env, headers);
  if (!user) return UNAUTHENTICATED;
  const session = await sessionInfo(env, headers);
  let project: { repo: { owner: string; name: string; defaultBranch: string } } | undefined;
  for (const org of session?.orgs ?? []) {
    const listed = await invokeAs(env.ENGINE, user.id, "project.list", { orgId: org.id });
    if (listed.ok && listed.status === "ok") {
      const projects = (listed.output as { projects: { id: string; repo: never }[] }).projects;
      project = projects.find((p) => p.id === projectId);
      if (project) break;
    }
  }
  if (!project) return { ok: false, code: "not_found", message: "no such project" };
  const { owner, name, defaultBranch } = project.repo;
  const gh = {
    headers: { "user-agent": "software-factory", accept: "application/vnd.github+json" },
  };
  const branch = await fetcher(
    `https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(defaultBranch)}`,
    gh,
  );
  if (!branch.ok) {
    return {
      ok: false,
      code: "unavailable",
      message: `GitHub answered ${branch.status} for ${owner}/${name}@${defaultBranch}`,
    };
  }
  const sha = ((await branch.json()) as { sha: string }).sha;
  const file = await fetcher(
    `https://raw.githubusercontent.com/${owner}/${name}/${sha}/${POLICY_PATH}`,
    gh,
  );
  const content = file.ok ? await file.text() : null;
  return invokeAs(env.ENGINE, user.id, "policy.sync", {
    projectId,
    ref: `refs/heads/${defaultBranch}`,
    sha,
    content,
  });
}

/**
 * The GitHub App installation that covers owner/repo, found with the signed-in user's own GitHub
 * App user token from sign-in (read-only: lists the installations they can see). Null when the App
 * isn't installed there or the token is gone.
 */
export async function findInstallation(
  env: AppEnv,
  headers: Headers,
  repo: { owner: string; name: string },
  fetcher: Fetch = fetch,
): Promise<{ installationId: string | null; reason: string | null }> {
  const user = await userFromRequest(env, headers);
  if (!user) return { installationId: null, reason: "not signed in" };
  const account = await env.DB.prepare(
    "SELECT access_token FROM core_account WHERE user_id = ? AND provider_id = 'github' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(user.id)
    .first<{ access_token: string | null }>();
  if (!account?.access_token)
    return { installationId: null, reason: "no GitHub token: sign in again" };
  const gh = {
    headers: {
      authorization: `Bearer ${account.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "software-factory",
    },
  };
  const list = await fetcher("https://api.github.com/user/installations?per_page=100", gh);
  if (!list.ok) return { installationId: null, reason: `GitHub answered ${list.status}` };
  const { installations } = (await list.json()) as {
    installations: { id: number; account: { login: string } | null }[];
  };
  for (const inst of installations) {
    if (inst.account?.login.toLowerCase() !== repo.owner.toLowerCase()) continue;
    const repos = await fetcher(
      `https://api.github.com/user/installations/${inst.id}/repositories?per_page=100`,
      gh,
    );
    if (!repos.ok) continue;
    const body = (await repos.json()) as { repositories: { name: string }[] };
    if (body.repositories.some((r) => r.name.toLowerCase() === repo.name.toLowerCase())) {
      return { installationId: String(inst.id), reason: null };
    }
  }
  return {
    installationId: null,
    reason: `the GitHub App isn't installed on ${repo.owner}/${repo.name}`,
  };
}
