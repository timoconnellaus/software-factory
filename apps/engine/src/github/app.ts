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
  OperationError,
  type RepoGuards,
  type RepoRef,
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

  async function appJwt(): Promise<string> {
    key ??= importPrivateKey(config.privateKey);
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
    const id = `${repo.installationId}/${repo.owner}/${repo.repo}/${Object.keys(permissions).join(",")}`;
    const cached = cache.get(id);
    if (cached && Date.parse(cached.expiresAt) - now().getTime() > 5 * 60_000) return cached.token;
    const fresh = await installationToken(repo, permissions);
    cache.set(id, fresh);
    return fresh.token;
  }

  async function api(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
    permissions: Record<string, string> = CONTROL_PLANE_PERMISSIONS,
  ): Promise<{ status: number; json: unknown }> {
    const response = await doFetch(`${API}/repos/${repo.owner}/${repo.repo}${path}`, {
      method,
      headers: headers(`token ${await controlToken(repo, permissions)}`),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
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
  async function metadataToken(
    installationId: string,
    repositoryIds?: number[],
  ): Promise<{ ok: true; token: string } | { ok: false; status: number; message: string }> {
    const cacheKey = `meta:${installationId}:${repositoryIds?.join(",") ?? "*"}`;
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
    mintRepoToken: (repo) => installationToken(repo, JOB_TOKEN_PERMISSIONS),
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
      const token = await metadataToken(installationId);
      if (!token.ok) {
        throw new Error(`GitHub installation token: HTTP ${token.status} ${token.message}`);
      }
      const out: InstallationRepo[] = [];
      for (let page = 1; page <= 20; page++) {
        const response = await doFetch(
          `${API}/installation/repositories?per_page=100&page=${page}`,
          { headers: headers(`token ${token.token}`) },
        );
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
      const token = await metadataToken(installationId, [repoId]);
      if (!token.ok) {
        if (token.status === 422 || token.status === 404) return null;
        throw new OperationError(
          "unavailable",
          `GitHub answered ${token.status} for an installation token: ${token.message}`,
        );
      }
      const response = await doFetch(`${API}/repositories/${repoId}`, {
        headers: headers(`token ${token.token}`),
      });
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
    async mergePullRequest(repo, { number, sha, method }) {
      const r = await api(repo, "PUT", `/pulls/${number}/merge`, { sha, merge_method: method });
      if (r.status === 200) return { merged: true, sha: (r.json as { sha: string }).sha };
      if ([405, 409, 422].includes(r.status)) {
        return {
          merged: false,
          reason: (r.json as { message?: string })?.message ?? `HTTP ${r.status}`,
        };
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
            }[];
          }
        ).files ?? [];
      return files.map((f) => ({
        path: f.filename,
        status: f.status,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
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
          });
        }
        if (out.length >= body.total_count || body.check_runs.length === 0) break;
      }
      return out;
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
