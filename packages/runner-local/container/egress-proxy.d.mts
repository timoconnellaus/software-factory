// Types for the egress proxy script (egress-proxy.mjs), for runner-local's tests.
import type { Server } from "node:http";

export function hostAllowed(host: string, port: number, allow: readonly string[]): boolean;
/** Whether an IP is one no allowlisted name may reach (private, loopback, link-local, …). */
export function notPublic(address: string, extra?: readonly string[]): boolean;
export function createEgressProxy(options: {
  allow: readonly string[];
  /** Exact `host:port` entries exempt from the private-address filter (the runner's tests). */
  privateOk?: readonly string[];
  /** DNS (default `node:dns/promises` lookup); tests inject one. */
  lookup?: (
    host: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  log?: (line: {
    time: string;
    method: string;
    host: string;
    port: number;
    allowed: boolean;
    reason?: string;
  }) => void;
}): Server;
