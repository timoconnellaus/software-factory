// A plugin's call to an outside system through one of its org's gateways. The plugin's worker has
// no network: the host resolves the gateway by name, joins its base URL and the path, adds the
// credential, makes the request and hands back status, headers and body.
import { gatewayForHost, type Item, orgInstallations } from "@software-factory/store";
import type { Session } from "./dispatch.ts";
import { GITHUB_GATEWAY, GITHUB_GATEWAY_PERMISSIONS, type PluginHostEnv } from "./types.ts";

export interface GatewayRequest {
  method?: string;
  headers?: [string, string][];
  body?: string | null;
}

export interface GatewayResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/**
 * The base URL with `path` under it. A path that leaves the base (another origin, a scheme, `..`
 * above the base's path) is refused.
 */
export function joinUrl(base: string, path: string): URL {
  const root = new URL(base);
  const prefix = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[\\/]{2}/.test(path)) {
    throw new Error(`"${path}" isn't a path under the gateway's base URL.`);
  }
  const url = new URL(prefix + path.replace(/^[\\/]+/, ""), root.origin);
  if (url.origin !== root.origin || !`${url.pathname}/`.startsWith(prefix)) {
    throw new Error(`"${path}" leaves the gateway's base URL.`);
  }
  return url;
}

/** The built-in gateway's API root. */
export const GITHUB_API = "https://api.github.com";

/**
 * The built-in `github` gateway: the GitHub REST API for the repository of the item's project, as
 * the org's GitHub App with a one-repository token (contents and pull requests write, checks read).
 * `path` is under `/repos/<owner>/<name>`. A hook with no item, an item whose project has no
 * repository, or an org whose installation is gone gets a plain error.
 */
export async function githubGatewayFetch(
  env: PluginHostEnv,
  session: Session,
  orgId: string,
  item: Item | null,
  path: string,
  init: GatewayRequest,
): Promise<GatewayResponse> {
  const github = env.github;
  if (!github) throw new Error("This engine has no GitHub App, so the github gateway isn't there.");
  if (!item) {
    throw new Error("The github gateway works on the item's repository; this hook has no item.");
  }
  const repo = await session.repo(item.projectId);
  if (!repo) throw new Error("This item's project has no repository (set one in its Settings).");
  const active = await orgInstallations(env.DB, orgId);
  if (!active.some((i) => i.installationId === repo.installationId)) {
    throw new Error(
      `The org's GitHub connection to ${repo.owner}/${repo.name} is gone; connect GitHub again.`,
    );
  }
  const url = joinUrl(
    `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    path,
  );
  const { token } = await github.repoToken(
    { installationId: repo.installationId, owner: repo.owner, name: repo.name },
    GITHUB_GATEWAY_PERMISSIONS,
    { cache: true },
  );
  const headers = new Headers(init.headers ?? []);
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
  if (!headers.has("x-github-api-version")) headers.set("x-github-api-version", "2022-11-28");
  headers.set("user-agent", "software-factory-engine");
  return send(url, headers, init);
}

async function send(url: URL, headers: Headers, init: GatewayRequest): Promise<GatewayResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" || init.body == null ? {} : { body: init.body }),
  });
  return { status: res.status, headers: [...res.headers], body: await res.text() };
}

/** Makes the request through the org's gateway `name`. Every failure is a plain error. */
export async function gatewayFetch(
  env: PluginHostEnv,
  orgId: string,
  name: string,
  path: string,
  init: GatewayRequest,
): Promise<GatewayResponse> {
  if (name === GITHUB_GATEWAY) {
    throw new Error(
      'The github gateway is built in: call it from a hook, as ctx.gateway("github").',
    );
  }
  const gateway = await gatewayForHost(env.DB, env.FLOW_GATEWAY_KEY, orgId, name);
  if (!gateway) throw new Error(`There is no gateway "${name}" in this org.`);
  const url = joinUrl(gateway.baseUrl, path);
  const headers = new Headers(init.headers ?? []);
  const { auth } = gateway;
  if (auth.kind !== "none") {
    if (!gateway.secret) throw new Error(`The gateway "${name}" has no secret set.`);
    if (auth.kind === "bearer") headers.set("authorization", `Bearer ${gateway.secret}`);
    else headers.set(auth.header, gateway.secret);
  }
  return send(url, headers, init);
}
