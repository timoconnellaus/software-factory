// The new core's use of the engine's GitHub App (spec 70, the software plugin): the repositories an
// installation reaches, one-repository installation tokens, and a branch's head. The plugin host
// gets it as `PluginHostEnv.github` (packages/plugins never imports the engine or packages/core).
// Plumbing only: the App client in ../github/app.ts, or the fake under GITHUB_FAKE=1.
import { fakeGitHub } from "@software-factory/core/testing";
import type { FlowGitHub, GitHubRepoRef } from "@software-factory/plugins";
import { appFor } from "../deps.ts";
import { secrets } from "../secrets.ts";

/** A runner's token for a flow run: push to its one repository, nothing else (ADR 0033). */
export const FLOW_JOB_TOKEN_PERMISSIONS = { contents: "write" } as const;

/**
 * Tokens the built-in gateway minted, by repository and permissions, kept in the isolate until 5
 * minutes before they expire (AGENTS.md, Cloudflare cost, rule 10: one mint per repository, not per
 * call). A runner's token is never kept.
 */
const cached = new Map<string, { token: string; expiresAt: string }>();
const CACHE_LIMIT = 200;

const refOf = (repo: GitHubRepoRef) => ({
  installationId: repo.installationId,
  owner: repo.owner,
  repo: repo.name,
});

export function flowGitHub(env: Env): FlowGitHub | undefined {
  if (env.GITHUB_FAKE === "1") {
    const fake = fakeGitHub(env.DB);
    return {
      installationRepos: async (id) =>
        (await fake.listInstallationRepos(id)).map((r) => ({
          owner: r.owner,
          name: r.name,
          defaultBranch: r.defaultBranch,
        })),
      // The fake counts the mints (its `tokens`), whatever the permissions.
      repoToken: (repo) => fake.mintRepoToken(refOf(repo)),
      branchSha: (repo, branch) => fake.getBranchSha(refOf(repo), branch),
    };
  }
  const key = secrets(env).GH_APP_PRIVATE_KEY;
  if (!key) return undefined;
  const app = appFor(env.GH_APP_ID, env.GH_APP_SLUG, key);
  return {
    installationRepos: async (id) =>
      (await app.listInstallationRepos(id)).map((r) => ({
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
      })),
    async repoToken(repo, permissions, opts) {
      const id = `${repo.installationId}/${repo.owner}/${repo.name}/${JSON.stringify(permissions)}`;
      const hit = opts?.cache ? cached.get(id) : undefined;
      if (hit && Date.parse(hit.expiresAt) - Date.now() > 5 * 60_000) return hit;
      const fresh = await app.installationToken(refOf(repo), permissions);
      if (opts?.cache) {
        if (cached.size >= CACHE_LIMIT) cached.clear();
        cached.set(id, fresh);
      }
      return fresh;
    },
    branchSha: (repo, branch) => app.getBranchSha(refOf(repo), branch),
  };
}
