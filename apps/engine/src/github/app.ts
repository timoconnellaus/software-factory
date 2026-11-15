// The GitHub App (ADR 0025, 0033, 0055): what the platform and the new core use. Mints installation
// tokens from the App's private key (a JWT signed RS256 with Web Crypto), looks up installations
// and the repositories they reach (connecting GitHub, the repository picker), and reads a branch's
// head (where a flow run starts). Tokens for a runner are minted per run and never stored; pushes
// are confined to `factory/*` by the repository's rulesets.
import {
  type GitHubService,
  type InstallationInfo,
  type InstallationRepo,
  OperationError,
  type RepoRef,
} from "@software-factory/core";

const API = "https://api.github.com";
const USER_AGENT = "software-factory-engine";

export interface GitHubAppConfig {
  appId: string;
  /** The App's slug: its install page is `github.com/apps/<slug>`. */
  appSlug: string;
  /** The App's private key, PEM (GitHub issues PKCS#1 "BEGIN RSA PRIVATE KEY"; PKCS#8 works too). */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Permissions of a runner's token by default: push to one repo, nothing else (ADR 0033). */
export const JOB_TOKEN_PERMISSIONS = { contents: "write" } as const;
/** Reading a branch's head. */
const READ_PERMISSIONS = { contents: "read" } as const;
/** Listing the repositories an installation reaches (the repo picker, ADR 0055). */
const METADATA_PERMISSIONS = { metadata: "read" } as const;

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
  /** The engine's own read and metadata tokens, kept until 5 minutes before they expire. */
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

  /**
   * A cached token's call, made once more with a fresh token on 401 (a token GitHub no longer
   * accepts: revoked, or its installation changed). The client lives as long as the isolate, so a
   * bad token must not stay cached until it expires.
   */
  async function withCached(
    cacheKey: string,
    mint: () => Promise<{ token: string; expiresAt: string }>,
    send: (token: string) => Promise<Response>,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let token = cache.get(cacheKey);
      if (!token || Date.parse(token.expiresAt) - now().getTime() <= 5 * 60_000) {
        token = await mint();
        cache.set(cacheKey, token);
      }
      const response = await send(token.token);
      if (response.status !== 401 || attempt > 0) return response;
      cache.delete(cacheKey);
    }
  }

  /** A metadata-only token for every repo the installation reaches. */
  async function metadataToken(installationId: string) {
    const response = await doFetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: headers(`Bearer ${await appJwt()}`),
      body: JSON.stringify({ permissions: METADATA_PERMISSIONS }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub installation token: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: body.expires_at };
  }

  /** Asks GitHub as the App (its JWT). */
  async function asApp(path: string): Promise<Response> {
    return doFetch(`${API}${path}`, { headers: headers(`Bearer ${await appJwt()}`) });
  }

  return {
    app: { id: config.appId, slug: config.appSlug },
    appJwt,
    installationToken,
    mintRepoToken: (repo, permissions = JOB_TOKEN_PERMISSIONS) =>
      installationToken(repo, permissions),
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
        const response = await withCached(
          `meta:${installationId}`,
          () => metadataToken(installationId),
          (token) =>
            doFetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
              headers: headers(`token ${token}`),
            }),
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
    async getBranchSha(repo, branch) {
      const ref = branch.split("/").map(encodeURIComponent).join("/");
      const response = await withCached(
        `read:${repo.installationId}/${repo.owner}/${repo.repo}`,
        () => installationToken(repo, READ_PERMISSIONS),
        (token) =>
          doFetch(`${API}/repos/${repo.owner}/${repo.repo}/git/ref/heads/${ref}`, {
            headers: headers(`token ${token}`),
          }),
      );
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`GitHub ref ${branch}: HTTP ${response.status} ${await response.text()}`);
      }
      return ((await response.json()) as { object: { sha: string } }).object.sha;
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

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
