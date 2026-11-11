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
import { type GitHubService, OperationError, type RepoRef } from "@software-factory/core";

const API = "https://api.github.com";
const USER_AGENT = "software-factory-engine";

export interface GitHubAppConfig {
  appId: string;
  /** The App's private key, PEM (GitHub issues PKCS#1 "BEGIN RSA PRIVATE KEY"; PKCS#8 works too). */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Permissions of the job token: push to one repo, nothing else (ADR 0033). */
export const JOB_TOKEN_PERMISSIONS = { contents: "write" } as const;
/** Permissions the control plane uses for branches, spec commits, PRs and merges. */
export const CONTROL_PLANE_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

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

  async function controlToken(repo: RepoRef): Promise<string> {
    const id = `${repo.installationId}/${repo.owner}/${repo.repo}`;
    const cached = cache.get(id);
    if (cached && Date.parse(cached.expiresAt) - now().getTime() > 5 * 60_000) return cached.token;
    const fresh = await installationToken(repo, CONTROL_PLANE_PERMISSIONS);
    cache.set(id, fresh);
    return fresh.token;
  }

  async function api(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await doFetch(`${API}/repos/${repo.owner}/${repo.repo}${path}`, {
      method,
      headers: headers(`token ${await controlToken(repo)}`),
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

  return {
    appJwt,
    installationToken,
    mintRepoToken: (repo) => installationToken(repo, JOB_TOKEN_PERMISSIONS),
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
