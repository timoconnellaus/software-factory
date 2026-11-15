// A plugin's call to an outside system through one of its org's gateways. The plugin's worker has
// no network: the host resolves the gateway by name, joins its base URL and the path, adds the
// credential, makes the request and hands back status, headers and body.
import { gatewayForHost } from "@software-factory/store";
import type { PluginHostEnv } from "./types.ts";

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

/** Makes the request through the org's gateway `name`. Every failure is a plain error. */
export async function gatewayFetch(
  env: PluginHostEnv,
  orgId: string,
  name: string,
  path: string,
  init: GatewayRequest,
): Promise<GatewayResponse> {
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
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" || init.body == null ? {} : { body: init.body }),
  });
  return { status: res.status, headers: [...res.headers], body: await res.text() };
}
