// The GitHub App, as the factory (ADR 0025, 0033, 0052). Mints installation tokens from the App's
// private key (a JWT signed RS256 with Web Crypto) and implements the core's GitHubService over the
// REST API.
//
// Two kinds of installation token:
// - the **job token** (`mintRepoToken`): one repository, `contents: write` only, handed to a runner
//   for one job and never stored. GitHub can't limit a token to a branch; pushes are confined to
//   `factory/*` by repository rulesets and checked by the control plane (ADR 0052);
// - the **control-plane token**: one repository, contents + pull requests, used here only, cached
//   in memory until shortly before it expires.
import {
  type ChangedFile,
  type CheckRunInfo,
  type GitHubService,
  type InstallationInfo,
  type InstallationRepo,
  mergeBaseAmbiguousFrom,
  OperationError,
  type PullRequestInfo,
  type RepoGuards,
  type RepoRef,
  type SinceBase,
} from "@software-factory/core";

const API = "https://api.github.com";
const USER_AGENT = "software-factory-engine";

export interface GitHubAppConfig {
  appId: string;
  /** The App's slug: its pushes show up as `<slug>[bot]` (ADR 0052, the push webhook). */
  appSlug: string;
  /** The App's private key, PEM (GitHub issues PKCS#1 "BEGIN RSA PRIVATE KEY"; PKCS#8 works too). */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Permissions of the job token: push to one repo, nothing else (ADR 0033). */
export const JOB_TOKEN_PERMISSIONS = { contents: "write" } as const;
/** A job that pushes nothing (a babysit job judging a failed check, spec 53): read only. */
export const JOB_READ_TOKEN_PERMISSIONS = { contents: "read" } as const;
/** Permissions the control plane uses for branches, spec commits, PRs and merges. */
export const CONTROL_PLANE_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;
/** Posting and reading check runs (`factory/verify`, CI). A separate token, so an App installed
 * without `checks` still opens and merges PRs, and the failure names what's missing. */
export const CHECKS_PERMISSIONS = { checks: "write" } as const;
/** Reading branch protection and rulesets at onboarding (spec 04). */
export const ADMIN_READ_PERMISSIONS = { administration: "read" } as const;
/** Listing the repositories an installation reaches (the repo picker, ADR 0055). */
export const METADATA_PERMISSIONS = { metadata: "read" } as const;

interface GitHubRepoJson {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
}
const toRepo = (r: GitHubRepoJson): InstallationRepo => ({
  id: r.id,
  owner: r.owner.login,
  name: r.name,
  private: r.private,
  defaultBranch: r.default_branch,
});

/** GitHub lists at most this many files in one compare (spec 53: a fuller change fails closed). */
const COMPARE_FILES_CAP = 300;

export function githubApp(config: GitHubAppConfig): GitHubService & {
  appJwt(): Promise<string>;
  installationToken(
    repo: RepoRef,
    permissions: Record<string, string>,
  ): Promise<{ token: string; expiresAt: string }>;
} {
  const doFetch = config.fetch ?? fetch;
  const now = () => config.now?.() ?? new Date();
  let key: Promise<CryptoKey> | null = null;
  const cache = new Map<string, { token: string; expiresAt: string }>();

  // The App JWT lives 9 minutes; reused while it has more than one left, so a client kept for the
  // isolate's life signs one every 8 minutes instead of one per GitHub call.
  let jwt: { value: string; exp: number } | null = null;

  async function appJwt(): Promise<string> {
    const nowS = Math.floor(now().getTime() / 1000);
    if (jwt && jwt.exp - nowS > 60) return jwt.value;
    jwt = { value: await signAppJwt(), exp: nowS - 60 + 540 };
    return jwt.value;
  }

  async function signAppJwt(): Promise<string> {
    // A failed import isn't kept: the client lives as long as the isolate.
    key ??= importPrivateKey(config.privateKey).catch((error: unknown) => {
      key = null;
      throw error;
    });
    const iat = Math.floor(now().getTime() / 1000) - 60;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: config.appId }));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
  }

  async function installationToken(repo: RepoRef, permissions: Record<string, string>) {
    const response = await doFetch(
      `${API}/app/installations/${repo.installationId}/access_tokens`,
      {
        method: "POST",
        headers: headers(`Bearer ${await appJwt()}`),
        body: JSON.stringify({ repositories: [repo.repo], permissions }),
      },
    );
    if (!response.ok) {
      throw new OperationError(
        "unavailable",
        `GitHub App token for ${repo.owner}/${repo.repo}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: body.expires_at };
  }

  async function controlToken(
    repo: RepoRef,
    permissions: Record<string, string> = CONTROL_PLANE_PERMISSIONS,
  ): Promise<string> {
    const id = controlKey(repo, permissions);
    const cached = cache.get(id);
    if (cached && Date.parse(cached.expiresAt) - now().getTime() > 5 * 60_000) return cached.token;
    const fresh = await installationToken(repo, permissions);
    cache.set(id, fresh);
    return fresh.token;
  }

  const controlKey = (repo: RepoRef, permissions: Record<string, string>) =>
    `${repo.installationId}/${repo.owner}/${repo.repo}/${Object.keys(permissions).join(",")}`;

  /**
   * Fetches with a cached installation token; on 401 (a token GitHub no longer accepts: revoked, or
   * its installation changed) the token is dropped and the call made once more with a fresh one.
   * The client lives as long as the isolate, so a bad token must not stay cached until it expires.
   */
  async function withCachedToken(
    cacheKey: string,
    token: () => Promise<string>,
    send: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const response = await send(await token());
    if (response.status !== 401) return response;
    cache.delete(cacheKey);
    return send(await token());
  }

  async function api(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
    permissions: Record<string, string> = CONTROL_PLANE_PERMISSIONS,
  ): Promise<{ status: number; json: unknown }> {
    const response = await withCachedToken(
      controlKey(repo, permissions),
      () => controlToken(repo, permissions),
      (token) =>
        doFetch(`${API}/repos/${repo.owner}/${repo.repo}${path}`, {
          method,
          headers: headers(`token ${token}`),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  }
  /** A GraphQL query as the repository's control-plane token (read-only uses). */
  async function graphql(
    repo: RepoRef,
    query: string,
    variables: Record<string, string>,
  ): Promise<unknown> {
    const response = await withCachedToken(
      controlKey(repo, CONTROL_PLANE_PERMISSIONS),
      () => controlToken(repo, CONTROL_PLANE_PERMISSIONS),
      (token) =>
        doFetch(`${API}/graphql`, {
          method: "POST",
          headers: headers(`token ${token}`),
          body: JSON.stringify({ query, variables }),
        }),
    );
    if (response.status !== 200) {
      throw new Error(`GitHub GraphQL: HTTP ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
  const fail = (what: string, r: { status: number; json: unknown }): never => {
    throw new Error(`GitHub ${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  };
  const ref = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

  const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

  /** Asks GitHub as the App (its JWT). */
  async function asApp(path: string): Promise<Response> {
    return doFetch(`${API}${path}`, { headers: headers(`Bearer ${await appJwt()}`) });
  }

  /**
   * A metadata-only installation token: for every repo the installation reaches, or only for
   * `repositoryIds` (GitHub refuses with 422 when the installation can't reach one of them).
   */
  const metaKey = (installationId: string, repositoryIds?: number[]) =>
    `meta:${installationId}:${repositoryIds?.join(",") ?? "*"}`;

  /** A metadata token's call, made once more with a fresh token on 401 (see withCachedToken). */
  async function withMetadataToken(
    installationId: string,
    repositoryIds: number[] | undefined,
    send: (token: string) => Promise<Response>,
  ): Promise<{ ok: true; response: Response } | { ok: false; status: number; message: string }> {
    for (let attempt = 0; ; attempt++) {
      const token = await metadataToken(installationId, repositoryIds);
      if (!token.ok) return token;
      const response = await send(token.token);
      if (response.status !== 401 || attempt > 0) return { ok: true, response };
      cache.delete(metaKey(installationId, repositoryIds));
    }
  }

  async function metadataToken(
    installationId: string,
    repositoryIds?: number[],
  ): Promise<{ ok: true; token: string } | { ok: false; status: number; message: string }> {
    const cacheKey = metaKey(installationId, repositoryIds);
    const cached = cache.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) - now().getTime() > 5 * 60_000) {
      return { ok: true, token: cached.token };
    }
    const response = await doFetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: headers(`Bearer ${await appJwt()}`),
      body: JSON.stringify({
        permissions: METADATA_PERMISSIONS,
        ...(repositoryIds ? { repository_ids: repositoryIds } : {}),
      }),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, message: await response.text() };
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    cache.set(cacheKey, { token: body.token, expiresAt: body.expires_at });
    return { ok: true, token: body.token };
  }

  return {
    app: { id: config.appId, slug: config.appSlug },
    appJwt,
    installationToken,
    mintRepoToken: (repo, opts) =>
      installationToken(repo, opts?.readOnly ? JOB_READ_TOKEN_PERMISSIONS : JOB_TOKEN_PERMISSIONS),
    async getInstallation(installationId): Promise<InstallationInfo | null> {
      const response = await asApp(`/app/installations/${encodeURIComponent(installationId)}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new OperationError(
          "unavailable",
          `GitHub answered ${response.status} for the App's installation: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as {
        id: number;
        account: { login: string; type: string } | null;
        repository_selection: "all" | "selected";
        suspended_at: string | null;
      };
      if (!body.account) return null;
      return {
        installationId: String(body.id),
        account: {
          login: body.account.login,
          type: body.account.type === "Organization" ? "Organization" : "User",
        },
        repositorySelection: body.repository_selection,
        suspended: !!body.suspended_at,
      };
    },
    async listInstallationRepos(installationId) {
      const out: InstallationRepo[] = [];
      for (let page = 1; page <= 20; page++) {
        const sent = await withMetadataToken(installationId, undefined, (token) =>
          doFetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
            headers: headers(`token ${token}`),
          }),
        );
        if (!sent.ok) {
          throw new Error(`GitHub installation token: HTTP ${sent.status} ${sent.message}`);
        }
        const response = sent.response;
        if (!response.ok) {
          throw new Error(`GitHub installation repositories: HTTP ${response.status}`);
        }
        const body = (await response.json()) as {
          total_count: number;
          repositories: GitHubRepoJson[];
        };
        out.push(...body.repositories.map(toRepo));
        if (out.length >= body.total_count || body.repositories.length === 0) break;
      }
      return out;
    },
    async getInstallationRepo(installationId, repoId) {
      // A token limited to this one repo: GitHub refuses it (422) unless the installation reaches
      // it. Reading /repositories/{id} alone would also answer for any public repo.
      const sent = await withMetadataToken(installationId, [repoId], (token) =>
        doFetch(`${API}/repositories/${repoId}`, { headers: headers(`token ${token}`) }),
      );
      if (!sent.ok) {
        if (sent.status === 422 || sent.status === 404) return null;
        throw new OperationError(
          "unavailable",
          `GitHub answered ${sent.status} for an installation token: ${sent.message}`,
        );
      }
      const response = sent.response;
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new OperationError(
          "unavailable",
          `GitHub answered ${response.status} for repo ${repoId}`,
        );
      }
      return toRepo((await response.json()) as GitHubRepoJson);
    },
    async userInstallationIds(userToken) {
      const ids: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await doFetch(`${API}/user/installations?per_page=100&page=${page}`, {
          headers: headers(`Bearer ${userToken}`),
        });
        if (!response.ok) {
          throw new Error(`GitHub /user/installations answered ${response.status}`);
        }
        const body = (await response.json()) as {
          total_count: number;
          installations: { id: number }[];
        };
        ids.push(...body.installations.map((i) => String(i.id)));
        if (ids.length >= body.total_count || body.installations.length === 0) break;
      }
      return ids;
    },
    async findRepoInstallation(owner, repo) {
      const response = await doFetch(
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        { headers: headers(`Bearer ${await appJwt()}`) },
      );
      if (response.ok) {
        const body = (await response.json()) as { id: number };
        return { installationId: String(body.id), reason: null };
      }
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {}
      if (response.status === 404) {
        return {
          installationId: null,
          reason: `the GitHub App ${config.appSlug} isn't installed on ${owner}/${repo} (or its installation doesn't include that repo). Install it: https://github.com/apps/${config.appSlug}/installations/new`,
        };
      }
      if (response.status === 401) {
        return {
          installationId: null,
          reason: `GitHub refused the App's own credentials (401 ${message}): check GH_APP_ID and GH_APP_PRIVATE_KEY on sf-engine`,
        };
      }
      return {
        installationId: null,
        reason: `GitHub answered ${response.status} looking up the App's installation on ${owner}/${repo}: ${message}`,
      };
    },
    async getBranchSha(repo, branch) {
      const r = await api(repo, "GET", `/git/ref/heads/${ref(branch)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`ref ${branch}`, r);
      return (r.json as { object: { sha: string } }).object.sha;
    },
    async createBranch(repo, branch, sha) {
      const r = await api(repo, "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
      if (r.status === 201) return;
      if (r.status === 422 && /already exists/i.test(JSON.stringify(r.json))) return;
      fail(`create ${branch}`, r);
    },
    async fastForward(repo, branch, sha) {
      const r = await api(repo, "PATCH", `/git/refs/heads/${ref(branch)}`, { sha, force: false });
      if (r.status === 200) return { ok: true };
      if (r.status === 422)
        return { ok: false, reason: `not a fast-forward: ${JSON.stringify(r.json)}` };
      return fail(`fast-forward ${branch}`, r);
    },
    async commitFile(repo, { branch, path, content, message }) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const existing = await api(
        repo,
        "GET",
        `/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
      );
      const sha = existing.status === 200 ? (existing.json as { sha: string }).sha : undefined;
      const r = await api(repo, "PUT", `/contents/${encoded}`, {
        message,
        branch,
        content: b64(content),
        ...(sha ? { sha } : {}),
      });
      if (r.status !== 200 && r.status !== 201) fail(`commit ${path}`, r);
      return { commitSha: (r.json as { commit: { sha: string } }).commit.sha };
    },
    async commitFiles(repo, { branch, files, message }) {
      const ref = await api(repo, "GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
      if (ref.status !== 200) fail(`read ${branch}`, ref);
      const head = (ref.json as { object: { sha: string } }).object.sha;
      const parent = await api(repo, "GET", `/git/commits/${head}`);
      if (parent.status !== 200) fail(`read commit ${head}`, parent);
      const baseTree = (parent.json as { tree: { sha: string } }).tree.sha;
      const tree = await api(repo, "POST", "/git/trees", {
        base_tree: baseTree,
        tree: files.map((f) => ({
          path: f.path,
          mode: "100644",
          type: "blob",
          content: f.content,
        })),
      });
      if (tree.status !== 201) fail("create tree", tree);
      const made = await api(repo, "POST", "/git/commits", {
        message,
        tree: (tree.json as { sha: string }).sha,
        parents: [head],
      });
      if (made.status !== 201) fail("create commit", made);
      const commitSha = (made.json as { sha: string }).sha;
      // A fast-forward only: a branch that moved meanwhile fails, rather than losing a commit.
      const moved = await api(repo, "PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commitSha,
        force: false,
      });
      if (moved.status !== 200) fail(`update ${branch}`, moved);
      return { commitSha };
    },
    async openPullRequest(repo, { head, base, title, body }) {
      const open = await api(
        repo,
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`,
      );
      const found = (open.json as { number: number; html_url: string }[] | null)?.[0];
      if (open.status === 200 && found) return { number: found.number, url: found.html_url };
      const r = await api(repo, "POST", "/pulls", { head, base, title, body });
      if (r.status !== 201) fail(`open PR ${head}`, r);
      const pr = r.json as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    },
    async getPullRequest(repo, number) {
      const r = await api(repo, "GET", `/pulls/${number}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`read PR #${number}`, r);
      return pullInfo(r.json as GitHubPull);
    },
    async listOpenPullRequests(repo) {
      const r = await api(
        repo,
        "GET",
        "/pulls?state=open&sort=created&direction=desc&per_page=100",
      );
      if (r.status !== 200) fail("list open PRs", r);
      return ((r.json as GitHubPull[] | null) ?? []).map(pullInfo);
    },
    async pullRequestMergeability(repo, number) {
      const r = await api(repo, "GET", `/pulls/${number}`);
      if (r.status !== 200) fail(`pull request #${number}`, r);
      const pr = r.json as {
        mergeable: boolean | null;
        mergeable_state?: string | null;
        head?: { sha?: string };
      };
      return {
        mergeable: pr.mergeable ?? null,
        mergeableState: pr.mergeable_state ?? null,
        headSha: pr.head?.sha ?? null,
      };
    },
    async compareCommits(repo, base, head) {
      const r = await api(
        repo,
        "GET",
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      );
      if (r.status !== 200) fail(`compare ${base}...${head}`, r);
      const c = r.json as { ahead_by?: number; behind_by?: number };
      return { aheadBy: c.ahead_by ?? 0, behindBy: c.behind_by ?? 0 };
    },
    async commitParents(repo, sha) {
      const r = await api(repo, "GET", `/commits/${encodeURIComponent(sha)}`);
      if (r.status !== 200) fail(`commit ${sha}`, r);
      return ((r.json as { parents?: { sha: string }[] }).parents ?? []).map((p) => p.sha);
    },
    async commitTime(repo, sha) {
      // The git data API: no file list, unlike /commits/{sha}.
      const r = await api(repo, "GET", `/git/commits/${encodeURIComponent(sha)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`commit ${sha}`, r);
      return (r.json as { committer?: { date?: string } }).committer?.date ?? null;
    },
    async commitInfo(repo, sha) {
      const r = await api(repo, "GET", `/git/commits/${encodeURIComponent(sha)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`commit ${sha}`, r);
      const c = r.json as {
        parents?: { sha: string }[];
        committer?: { name?: string; email?: string } | null;
        verification?: { verified?: boolean } | null;
      };
      return {
        parents: (c.parents ?? []).map((p) => p.sha),
        committer: c.committer
          ? { name: String(c.committer.name ?? ""), email: String(c.committer.email ?? "") }
          : null,
        verified: c.verification?.verified === true,
      };
    },
    async changedPaths(repo, base, head) {
      const r = await api(
        repo,
        "GET",
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      );
      if (r.status === 404) return { mergeBase: null, paths: [], complete: false };
      if (r.status !== 200) fail(`compare ${base}...${head}`, r);
      const body = r.json as {
        merge_base_commit?: { sha?: string };
        files?: { filename: string; previous_filename?: string }[];
      };
      const files = body.files ?? [];
      const paths = new Set<string>();
      for (const f of files) {
        paths.add(f.filename);
        if (f.previous_filename) paths.add(f.previous_filename);
      }
      return {
        mergeBase: body.merge_base_commit?.sha ?? null,
        paths: [...paths].sort(),
        // GitHub lists at most 300 files in a compare: at the cap some may be missing.
        complete: files.length < COMPARE_FILES_CAP,
      };
    },
    async mergeBaseAmbiguous(repo, a, b) {
      const since = async (base: string, head: string): Promise<SinceBase | null> => {
        const r = await api(
          repo,
          "GET",
          `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=250`,
        );
        if (r.status !== 200) return null;
        const body = r.json as {
          merge_base_commit?: { sha?: string };
          total_commits?: number;
          commits?: { sha: string; parents?: { sha: string }[] }[];
        };
        return {
          base: body.merge_base_commit?.sha ?? null,
          total: body.total_commits ?? 0,
          commits: (body.commits ?? []).map((c) => ({
            sha: c.sha,
            parents: (c.parents ?? []).map((p) => p.sha),
          })),
        };
      };
      const [ab, ba] = await Promise.all([since(a, b), since(b, a)]);
      // An ancestor of the base: the base is ahead of it and not behind (compare parent...base).
      return mergeBaseAmbiguousFrom(ab, ba, async (sha, base) => {
        const r = await api(
          repo,
          "GET",
          `/compare/${encodeURIComponent(sha)}...${encodeURIComponent(base)}?per_page=1`,
        );
        if (r.status !== 200) return null;
        return (r.json as { behind_by?: number }).behind_by === 0;
      });
    },
    async pathEntries(repo, sha, paths) {
      // One GraphQL query per batch of directories: each directory's entries (name, mode, blob),
      // never the whole tree. GraphQL gives the mode as a number: 33188 is 100644 in octal.
      const dirs = [...new Set(paths.map((p) => p.slice(0, Math.max(0, p.lastIndexOf("/")))))];
      const out: Record<string, { mode: string; sha: string }> = {};
      for (let i = 0; i < dirs.length; i += 50) {
        const batch = dirs.slice(i, i + 50);
        const fields = batch
          .map(
            (_, k) =>
              `d${k}: object(expression: $e${k}) { ... on Tree { entries { name mode oid } } }`,
          )
          .join(" ");
        const vars = batch.map((_, k) => `$e${k}: String!`).join(", ");
        const variables: Record<string, string> = { owner: repo.owner, name: repo.repo };
        batch.forEach((d, k) => {
          variables[`e${k}`] = `${sha}:${d}`;
        });
        const r = await graphql(
          repo,
          `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`,
          variables,
        );
        const data = (r as { data?: { repository?: Record<string, unknown> } }).data?.repository;
        if (!data) fail(`tree entries ${sha}`, { status: 200, json: r });
        batch.forEach((d, k) => {
          const tree = (
            data as Record<
              string,
              { entries?: { name: string; mode: number; oid: string }[] } | null
            >
          )[`d${k}`];
          for (const e of tree?.entries ?? []) {
            const path = d ? `${d}/${e.name}` : e.name;
            if (paths.includes(path)) out[path] = { mode: e.mode.toString(8), sha: e.oid };
          }
        });
      }
      return out;
    },
    async updatePullRequestBranch(repo, { number, expectedHeadSha }) {
      const r = await api(repo, "PUT", `/pulls/${number}/update-branch`, {
        expected_head_sha: expectedHeadSha,
      });
      if (r.status === 202) return { status: "requested" };
      const reason = (r.json as { message?: string })?.message ?? `HTTP ${r.status}`;
      // 422: a merge conflict, or the head moved past expected_head_sha.
      if (r.status === 422) {
        return /conflict/i.test(reason)
          ? { status: "conflict", reason }
          : { status: "refused", reason };
      }
      if ([403, 405, 409].includes(r.status)) return { status: "refused", reason };
      return fail(`update branch #${number}`, r);
    },
    async mergePullRequest(repo, { number, sha, method }) {
      const r = await api(repo, "PUT", `/pulls/${number}/merge`, { sha, merge_method: method });
      if (r.status === 200) return { merged: true, sha: (r.json as { sha: string }).sha };
      if ([405, 409, 422].includes(r.status)) {
        const reason = (r.json as { message?: string })?.message ?? `HTTP ${r.status}`;
        // 409: the `sha` we sent is no longer the head ("Head branch was modified").
        const headMoved = r.status === 409 || /head branch was modified/i.test(reason);
        return { merged: false, reason, ...(headMoved ? { headMoved } : {}) };
      }
      return fail(`merge #${number}`, r);
    },
    async changedFiles(repo, base, head) {
      const r = await api(
        repo,
        "GET",
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      );
      if (r.status !== 200) fail(`compare ${base}...${head}`, r);
      return ((r.json as { files?: { filename: string }[] }).files ?? []).map((f) => f.filename);
    },
    async compareFiles(repo, base, head) {
      // GitHub lists at most 300 files per compare; the auto-merge rule refuses a compare that big.
      const r = await api(
        repo,
        "GET",
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=300`,
      );
      if (r.status !== 200) fail(`compare ${base}...${head}`, r);
      const files =
        (
          r.json as {
            files?: {
              filename: string;
              status: ChangedFile["status"];
              previous_filename?: string;
              patch?: string;
              changes?: number;
            }[];
          }
        ).files ?? [];
      return files.map((f) => ({
        path: f.filename,
        status: f.status,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
        ...(typeof f.changes === "number" ? { changes: f.changes } : {}),
      }));
    },
    async readFile(repo, path, at) {
      const r = await api(repo, "GET", `/contents/${enc(path)}?ref=${encodeURIComponent(at)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`read ${path}@${at}`, r);
      const body = r.json as { content?: string; encoding?: string; type?: string };
      if (body.type !== "file" || typeof body.content !== "string") return null;
      return fromBase64Text(body.content);
    },
    async listCheckRuns(repo, at) {
      const out: CheckRunInfo[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await api(
          repo,
          "GET",
          `/commits/${encodeURIComponent(at)}/check-runs?per_page=100&page=${page}`,
          undefined,
          CHECKS_PERMISSIONS,
        );
        if (r.status !== 200) fail(`check runs ${at}`, r);
        const body = r.json as {
          total_count: number;
          check_runs: {
            id: number;
            name: string;
            status: CheckRunInfo["status"];
            conclusion: string | null;
            html_url: string | null;
            app: { slug: string } | null;
            started_at?: string | null;
            completed_at?: string | null;
          }[];
        };
        for (const c of body.check_runs) {
          out.push({
            id: String(c.id),
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            appSlug: c.app?.slug ?? null,
            url: c.html_url,
            startedAt: c.started_at ?? null,
            completedAt: c.completed_at ?? null,
          });
        }
        if (out.length >= body.total_count || body.check_runs.length === 0) break;
      }
      return out;
    },
    async revertPullRequest(repo, input) {
      const pr = await api(repo, "GET", `/pulls/${input.number}`);
      if (pr.status !== 200) fail(`read PR #${input.number}`, pr);
      const nodeId = (pr.json as { node_id: string }).node_id;
      const r = (await graphql(
        repo,
        `mutation($id: ID!, $title: String!, $body: String!) {
          revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) {
            revertPullRequest { number url headRefName headRefOid }
          }
        }`,
        { id: nodeId, title: input.title, body: input.body },
      )) as {
        data?: {
          revertPullRequest?: {
            revertPullRequest?: {
              number: number;
              url: string;
              headRefName: string;
              headRefOid: string;
            };
          };
        };
        errors?: unknown;
      };
      const made = r.data?.revertPullRequest?.revertPullRequest;
      if (!made) fail(`revert PR #${input.number}`, { status: 200, json: r });
      const m = made as NonNullable<typeof made>;
      return { number: m.number, branch: m.headRefName, headSha: m.headRefOid, url: m.url };
    },
    async closePullRequest(repo, number) {
      const r = await api(repo, "PATCH", `/pulls/${number}`, { state: "closed" });
      if (r.status !== 200) fail(`close PR #${number}`, r);
    },
    async commentOnPullRequest(repo, number, body) {
      const r = await api(repo, "POST", `/issues/${number}/comments`, {
        body: body.slice(0, 60_000),
      });
      if (r.status !== 201) fail(`comment on PR #${number}`, r);
    },
    async rerequestCheckRun(repo, checkRunId) {
      const r = await api(
        repo,
        "POST",
        `/check-runs/${encodeURIComponent(checkRunId)}/rerequest`,
        undefined,
        CHECKS_PERMISSIONS,
      );
      return r.status === 201
        ? { ok: true, reason: "" }
        : { ok: false, reason: `GitHub answered ${r.status} to the rerun` };
    },
    async checkRunDetail(repo, checkRunId) {
      const id = encodeURIComponent(checkRunId);
      const run = await api(repo, "GET", `/check-runs/${id}`, undefined, CHECKS_PERMISSIONS);
      if (run.status !== 200) return `GitHub answered ${run.status} for check run ${checkRunId}`;
      const output = (run.json as { output?: { title?: string; summary?: string; text?: string } })
        .output;
      const notes = await api(
        repo,
        "GET",
        `/check-runs/${id}/annotations?per_page=50`,
        undefined,
        CHECKS_PERMISSIONS,
      );
      const annotations =
        notes.status === 200
          ? (
              notes.json as {
                path: string;
                start_line: number;
                annotation_level: string;
                message: string;
              }[]
            ).map((a) => `${a.annotation_level} ${a.path}:${a.start_line}: ${a.message}`)
          : [];
      return [output?.title, output?.summary, output?.text, ...annotations]
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .join("\n")
        .slice(0, 12_000);
    },
    async postCheckRun(repo, check) {
      const body = {
        name: check.name,
        head_sha: check.headSha,
        status: check.status,
        ...(check.status === "completed" && check.conclusion
          ? { conclusion: check.conclusion, completed_at: now().toISOString() }
          : {}),
        ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
        ...(check.externalId ? { external_id: check.externalId } : {}),
        output: { title: check.title.slice(0, 250), summary: check.summary.slice(0, 65_000) },
      };
      const r = check.checkRunId
        ? await api(repo, "PATCH", `/check-runs/${check.checkRunId}`, body, CHECKS_PERMISSIONS)
        : await api(repo, "POST", "/check-runs", body, CHECKS_PERMISSIONS);
      if (r.status !== 200 && r.status !== 201) fail(`check run ${check.name}`, r);
      return { id: String((r.json as { id: number }).id) };
    },
    async repoGuards(repo, branch): Promise<RepoGuards> {
      const p = await api(
        repo,
        "GET",
        `/branches/${ref(branch)}/protection`,
        undefined,
        ADMIN_READ_PERMISSIONS,
      );
      if (p.status !== 200 && p.status !== 404) fail(`protection ${branch}`, p);
      const raw = p.json as {
        required_status_checks?: { checks?: { context: string; app_id: number | null }[] };
        enforce_admins?: { enabled: boolean };
      };
      const protection =
        p.status === 404
          ? null
          : {
              requiredChecks: (raw.required_status_checks?.checks ?? []).map((c) => ({
                context: c.context,
                appId: c.app_id ?? null,
              })),
              enforceAdmins: raw.enforce_admins?.enabled === true,
            };
      // Org rulesets too: they guard the branch as much as the repo's own.
      const list = await api(
        repo,
        "GET",
        "/rulesets?includes_parents=true&per_page=100",
        undefined,
        ADMIN_READ_PERMISSIONS,
      );
      if (list.status !== 200) fail("rulesets", list);
      const rulesets: RepoGuards["rulesets"] = [];
      for (const item of (list.json as { id: number }[]) ?? []) {
        const one = await api(
          repo,
          "GET",
          `/rulesets/${item.id}?includes_parents=true`,
          undefined,
          ADMIN_READ_PERMISSIONS,
        );
        if (one.status !== 200) continue;
        const rs = one.json as {
          id: number;
          name: string;
          enforcement: string;
          target?: string;
          conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
          rules?: { type: string; parameters?: Record<string, unknown> }[];
          bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode?: string }[];
        };
        rulesets.push({
          id: rs.id,
          name: rs.name,
          target: rs.target ?? "branch",
          enforcement: rs.enforcement,
          include: rs.conditions?.ref_name?.include ?? [],
          exclude: rs.conditions?.ref_name?.exclude ?? [],
          rules: (rs.rules ?? []).map((x) => ({
            type: x.type,
            ...(x.parameters ? { parameters: x.parameters } : {}),
          })),
          // GitHub leaves the list out for callers it won't show it to: unknown, not empty.
          bypassActors: rs.bypass_actors
            ? rs.bypass_actors.map((x) => ({
                actorType: x.actor_type,
                actorId: x.actor_id ?? null,
                bypassMode: x.bypass_mode ?? "always",
              }))
            : null,
        });
      }
      // GitHub's own answer for what is in force on the branch (org rulesets, patterns, evaluate
      // mode all resolved by GitHub).
      const inForce = await api(
        repo,
        "GET",
        `/rules/branches/${ref(branch)}?per_page=100`,
        undefined,
        METADATA_PERMISSIONS,
      );
      const branchRules =
        inForce.status === 200
          ? (
              inForce.json as {
                type: string;
                parameters?: Record<string, unknown>;
                ruleset_id: number;
              }[]
            ).map((x) => ({
              type: x.type,
              rulesetId: x.ruleset_id,
              ...(x.parameters ? { parameters: x.parameters } : {}),
            }))
          : null;
      return { protection, rulesets, branchRules };
    },
    async repoPermission(repo, login) {
      const r = await api(
        repo,
        "GET",
        `/collaborators/${encodeURIComponent(login)}/permission`,
        undefined,
        METADATA_PERMISSIONS,
      );
      if (r.status === 404) return null;
      if (r.status !== 200) fail(`permission of ${login}`, r);
      const body = r.json as { permission?: string; role_name?: string };
      return body.role_name ?? body.permission ?? null;
    },
    async appSettings() {
      const r = await asApp("/app");
      if (!r.ok) throw new Error(`GitHub /app: HTTP ${r.status} ${await r.text()}`);
      const body = (await r.json()) as { events?: string[]; permissions?: Record<string, string> };
      return { events: body.events ?? [], permissions: body.permissions ?? {} };
    },
  };
}

function headers(authorization: string): Record<string, string> {
  return {
    authorization,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": USER_AGENT,
    "content-type": "application/json",
  };
}

/** Imports an RSA private key from PEM, PKCS#8 or PKCS#1 (wrapped into PKCS#8 here). */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  const der = fromBase64(
    pem
      .replace(/\\n/g, "\n")
      .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, "")
      .replace(/\s+/g, ""),
  );
  const pkcs8 = pkcs1 ? wrapPkcs1(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** PKCS#8 PrivateKeyInfo { version 0, rsaEncryption AlgorithmIdentifier, OCTET STRING pkcs1 }. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const rsaAlgorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = version.length + rsaAlgorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array(1 + derLength(inner).length + inner);
  out.set([0x30, ...derLength(inner), ...version, ...rsaAlgorithm, ...octet]);
  out.set(pkcs1, out.length - pkcs1.length);
  return out;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fromBase64Text(text: string): string {
  return new TextDecoder().decode(fromBase64(text.replace(/\s+/g, "")));
}

function b64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The fields of GitHub's pull request object the factory reads. */
interface GitHubPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  draft?: boolean;
  user?: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

function pullInfo(p: GitHubPull): PullRequestInfo {
  return {
    number: p.number,
    url: p.html_url,
    title: p.title,
    body: p.body ?? "",
    state: p.state,
    // The list endpoint has no `merged`; `merged_at` says the same.
    merged: p.merged ?? Boolean(p.merged_at),
    draft: p.draft ?? false,
    author: p.user?.login ?? null,
    head: { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo?.full_name ?? null },
    base: { ref: p.base.ref },
    // Before a merge GitHub reports a test-merge commit here: only a merged PR's is its merge.
    mergeCommitSha: (p.merged ?? Boolean(p.merged_at)) ? (p.merge_commit_sha ?? null) : null,
  };
}
