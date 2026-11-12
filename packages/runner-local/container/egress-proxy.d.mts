// Types for the egress proxy script (egress-proxy.mjs), for runner-local's tests.
import type { Server } from "node:http";

export function hostAllowed(host: string, port: number, allow: readonly string[]): boolean;
export function createEgressProxy(options: {
  allow: readonly string[];
  log?: (line: {
    time: string;
    method: string;
    host: string;
    port: number;
    allowed: boolean;
  }) => void;
}): Server;
