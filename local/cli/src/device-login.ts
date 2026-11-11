// `sf login` (spec 07): ask the engine for a code, show it with the approval link, and poll until
// the person approves it in the app, where they pick the scope (theirs wins over what was asked).
// The token is handed over once. Mirrors sf-runner's login (ADR 0056); fetch, clock and output are
// injected so it is tested end to end against a fake engine.
import { CLI_PATHS, request } from "./api.ts";
import type { Scope } from "./config.ts";
import { CliError } from "./errors.ts";

export interface DeviceLoginOptions {
  /** The engine, e.g. https://sf-engine.zerobsai.com. */
  baseUrl: string;
  /** The app, used when the engine's approval link is relative. */
  appUrl: string;
  /** Suggested token name (shown in the app when approving). */
  name?: string;
  scope: Scope;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
  /** Called with the approval link, e.g. to open it in a browser. */
  open?: (url: string) => void;
}

export interface DeviceLoginResult {
  token: string;
  tokenId: string | null;
  scope: Scope;
  expiresAt: string | null;
  login: string | null;
}

interface Started {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

interface Polled {
  status: "pending" | "approved" | "denied" | "expired";
  token: string | null;
  tokenId: string | null;
  scope: Scope | null;
  expiresAt: string | null;
  login: string | null;
}

function parseStarted(json: unknown): Started {
  const s = (json ?? {}) as Record<string, unknown>;
  if (
    typeof s.deviceCode !== "string" ||
    typeof s.userCode !== "string" ||
    typeof s.verificationUrl !== "string" ||
    typeof s.expiresAt !== "string" ||
    typeof s.interval !== "number" ||
    !(s.interval > 0)
  ) {
    throw new CliError("bad_response", "the engine's device/start answer is malformed");
  }
  return s as unknown as Started;
}

const nullableString = (v: unknown) => (typeof v === "string" ? v : null);

function parsePolled(json: unknown): Polled {
  const p = (json ?? {}) as Record<string, unknown>;
  const status = p.status;
  if (
    status !== "pending" &&
    status !== "approved" &&
    status !== "denied" &&
    status !== "expired"
  ) {
    throw new CliError("bad_response", "the engine's device/poll answer is malformed");
  }
  return {
    status,
    token: nullableString(p.token),
    tokenId: nullableString(p.tokenId),
    scope: p.scope === "read" || p.scope === "write" ? p.scope : null,
    expiresAt: nullableString(p.expiresAt),
    login: nullableString(p.login),
  };
}

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const print = options.print ?? ((line: string) => console.log(line));
  const base = options.baseUrl.replace(/\/+$/, "");

  const body: { scope: Scope; name?: string } = { scope: options.scope };
  if (options.name) body.name = options.name;
  const start = parseStarted(
    (await request(doFetch, `${base}${CLI_PATHS.deviceStart}`, { method: "POST", body })).json,
  );
  const link = /^https?:/.test(start.verificationUrl)
    ? start.verificationUrl
    : `${options.appUrl.replace(/\/+$/, "")}${start.verificationUrl}`;
  print("");
  print(`To log in (asking for a ${options.scope} token), open:`);
  print(`  ${link}`);
  print(`and check the code: ${start.userCode}`);
  print("");
  print("Waiting for approval…");
  options.open?.(link);

  const deadline = Date.parse(start.expiresAt);
  let interval = start.interval * 1000;
  while (now() < deadline) {
    await sleep(interval);
    let answer: Polled;
    try {
      answer = parsePolled(
        (
          await request(doFetch, `${base}${CLI_PATHS.devicePoll}`, {
            method: "POST",
            body: { deviceCode: start.deviceCode },
          })
        ).json,
      );
    } catch (err) {
      // A 4xx is an answer (an unknown code, say): stop. Anything else is a blip while waiting:
      // back off and keep polling until the code expires.
      if (err instanceof CliError && err.status !== null && err.status < 500) throw err;
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    if (answer.status === "pending") continue;
    if (answer.status === "approved" && answer.token) {
      return {
        token: answer.token,
        tokenId: answer.tokenId,
        // The person picks the scope in the app; if the engine doesn't say, assume the narrower.
        scope: answer.scope ?? "read",
        expiresAt: answer.expiresAt,
        login: answer.login,
      };
    }
    if (answer.status === "denied") {
      throw new CliError("denied", "the login was denied in the app. Run `sf login` again.");
    }
    break;
  }
  throw new CliError(
    "expired",
    `the code ${start.userCode} expired before it was approved. Run \`sf login\` again.`,
  );
}
