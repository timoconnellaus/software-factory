// What a container job may reach (ADR 0430). The agent's container sits on an internal Docker
// network with no route out; its only way out is the job's egress proxy
// (`container/egress-proxy.mjs`), which allows these hosts and nothing else.
import { allowedDomains } from "@software-factory/harness-claude";
import type { HarnessProfile } from "@software-factory/runner-contract";

/** The model API the harness talks to. The one host every job needs on top of the stage's. */
export const MODEL_API_HOSTS = ["api.anthropic.com"];

/** Where the proxy listens, on the job network (its network alias). */
export const EGRESS_ALIAS = "egress";
export const EGRESS_PORT = 3128;
export const EGRESS_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;

/**
 * The job's allowlist: the stage's hosts from the project's harness profile (ADR 0270's defaults
 * plus the project's additions), the model API, and the runner's own extras.
 */
export function egressAllowlist(
  profile: HarnessProfile | undefined,
  extra: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      [...allowedDomains(profile), ...MODEL_API_HOSTS, ...extra].map((h) => h.toLowerCase()),
    ),
  ];
}

const DEFAULT_PORTS = [80, 443];

/**
 * Whether `host:port` is on the allowlist: an exact name, `*.suffix` for its subdomains, and ports
 * 443 and 80 unless the entry names one (`host:8080`). The proxy has the same rule.
 */
export function hostAllowed(host: string, port: number, allow: readonly string[]): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  for (const raw of allow) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    const pattern = m?.[1] ?? "";
    const ports = m?.[2] ? [Number(m[2])] : DEFAULT_PORTS;
    if (!ports.includes(port)) continue;
    if (pattern.startsWith("*.")) {
      if (name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/** The environment that sends the agent's traffic through the proxy. */
export function proxyEnv(url = EGRESS_URL): Record<string, string> {
  const local = "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: local,
    no_proxy: local,
    // Node's own fetch and http honour the variables above only with this.
    NODE_USE_ENV_PROXY: "1",
  };
}
