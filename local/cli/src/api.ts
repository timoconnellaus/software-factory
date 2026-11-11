// The engine's `/cli/v1` endpoint (spec 07, ADR 0340). A thin client: the token sets who calls and
// from where; permissions, scope, the browser-only rule and the audit are the engine's.
import { CliError } from "./errors.ts";

export const CLI_PATHS = {
  deviceStart: "/cli/v1/device/start",
  devicePoll: "/cli/v1/device/poll",
  call: "/cli/v1/call",
  ops: "/cli/v1/ops",
} as const;

export interface OperationInfo {
  name: string;
  description: string;
  risk: string;
  actors: string[];
  permission: string;
  gateKind: string | null;
  /** `true`, or `"some inputs"` when it depends on the input (a kill switch may go on, not off). */
  browserOnly: boolean | "some inputs";
}

export type CallOutcome =
  | { kind: "result"; result: unknown }
  /** The operation opened a gate: a person decides it in the app. */
  | { kind: "pending"; pendingActionId: string };

export interface Api {
  call(op: string, input: unknown): Promise<CallOutcome>;
  ops(): Promise<OperationInfo[]>;
}

export interface HttpOptions {
  url: string;
  token: string | null;
  fetch?: typeof fetch;
}

/** POST or GET JSON; a non-2xx answer becomes a CliError with the engine's code and message. */
export async function request(
  doFetch: typeof fetch,
  url: string,
  init: { method: "GET" | "POST"; token?: string | null; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new CliError(
      "unreachable",
      `can't reach ${new URL(url).origin}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const code =
      typeof body.code === "string"
        ? body.code
        : response.status === 401
          ? "unauthenticated"
          : `http_${response.status}`;
    const message =
      typeof body.error === "string"
        ? body.error
        : text.trim().slice(0, 300) || response.statusText || "no message";
    throw new CliError(code, message, response.status, body.details);
  }
  if (json === null) {
    throw new CliError("bad_response", `${url} answered ${response.status} with no JSON`);
  }
  return { status: response.status, json };
}

const notLoggedIn = () =>
  new CliError("unauthenticated", "not logged in (no stored token and no SF_TOKEN)", 401);

export function httpApi(options: HttpOptions): Api {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  return {
    async call(op, input) {
      if (!options.token) throw notLoggedIn();
      const { status, json } = await request(doFetch, `${base}${CLI_PATHS.call}`, {
        method: "POST",
        token: options.token,
        body: { op, input: input ?? {} },
      });
      const body = json as Record<string, unknown>;
      if (status === 202 || body.pending === true) {
        return { kind: "pending", pendingActionId: String(body.pendingActionId ?? "") };
      }
      if (!("result" in body)) {
        throw new CliError("bad_response", `${op}: the engine's answer has no result`);
      }
      return { kind: "result", result: body.result };
    },
    async ops() {
      if (!options.token) throw notLoggedIn();
      const { json } = await request(doFetch, `${base}${CLI_PATHS.ops}`, {
        method: "GET",
        token: options.token,
      });
      const ops = (json as { operations?: unknown }).operations;
      if (!Array.isArray(ops)) throw new CliError("bad_response", "the engine sent no operations");
      return ops as OperationInfo[];
    },
  };
}

/**
 * Call an operation and return its result. A friendly command never expects a gate to open; if
 * one does, say where to decide it rather than printing nothing.
 */
export async function result<T>(api: Api, op: string, input: unknown): Promise<T> {
  const outcome = await api.call(op, input);
  if (outcome.kind === "pending") {
    throw new CliError(
      "pending",
      `${op} is waiting on a decision in the app (pending action ${outcome.pendingActionId})`,
    );
  }
  // The engine validated the result against the operation's output schema; the views below read
  // only the fields they print.
  return outcome.result as T;
}
