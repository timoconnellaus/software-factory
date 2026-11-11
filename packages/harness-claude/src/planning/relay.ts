// The harness's side of the planning relay (ADR 0350): the planning MCP server and the hooks call the
// runner host's local relay, which signs each call onto the channel with the job's id and fencing
// token. The relay's address and per-job secret are in `<runDir>/planning.json`, which the agent's
// tools may not read.
import { readFile } from "node:fs/promises";
import type { PlanningOp } from "@software-factory/runner-contract";

/** `<runDir>/planning.json`: where the relay is, for this job. */
export const RELAY_FILE = "planning.json";

export interface RelayInfo {
  url: string;
  token: string;
  jobId: string;
  /** The work item's number, for the hooks' wording. */
  workItemNumber: number;
}

export async function readRelay(file: string): Promise<RelayInfo> {
  return JSON.parse(await readFile(file, "utf8")) as RelayInfo;
}

/** A refused call: `code` is the cloud's (`fenced` means the session is over). */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/** Calls one planning operation through the relay. */
export async function callRelay<T = unknown>(
  relay: Pick<RelayInfo, "url" | "token">,
  op: PlanningOp,
  input: Record<string, unknown> = {},
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${relay.url}/planning`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, input }),
    ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
  });
  const text = await response.text();
  let body: { ok?: boolean; result?: T; error?: string; code?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  if (!response.ok || body.ok === false) {
    throw new RelayError(response.status, body.code, body.error ?? `HTTP ${response.status}`);
  }
  return body.result as T;
}
