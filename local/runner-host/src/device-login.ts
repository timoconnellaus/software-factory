// `sf-runner login` (ADR 0056): ask the factory for a code, show it with the approval link, and poll
// until a person approves it in the app. The approval gives this machine its runner id and key; the
// key is never shown or copied. Kept apart from the CLI (fetch, clock and output injected) so it is
// tested end to end against a fake engine.
import { DEVICE_PATHS } from "@software-factory/runner-contract";
import { z } from "zod";

const started = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  expiresAt: z.string(),
  interval: z.number().int().positive(),
});

const polled = z.object({
  status: z.enum(["pending", "approved", "denied", "expired"]),
  runnerId: z.string().nullable(),
  name: z.string().nullable(),
  keyVersion: z.number().nullable(),
  key: z.string().nullable(),
});

export interface DeviceLoginOptions {
  /** The engine (runner channel), e.g. https://sf-engine.zerobsai.com. */
  baseUrl: string;
  /** The app, used when the engine's approval link is relative. */
  appUrl: string;
  /** Suggested runner name (the person can change it when approving). */
  name?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
  /** Called with the approval link, e.g. to open it in a browser. */
  open?: (url: string) => void;
}

export interface DeviceLoginResult {
  runnerId: string;
  name: string | null;
  key: string;
}

export class DeviceLoginError extends Error {
  override name = "DeviceLoginError";
}

async function post(doFetch: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!response.ok) {
    const message = json && typeof json === "object" && "error" in json ? String(json.error) : text;
    throw new DeviceLoginError(`The factory answered ${response.status}: ${message}`);
  }
  return json;
}

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const print = options.print ?? ((line: string) => console.log(line));
  const base = options.baseUrl.replace(/\/+$/, "");

  const start = started.parse(
    await post(doFetch, `${base}${DEVICE_PATHS.start}`, options.name ? { name: options.name } : {}),
  );
  const link = start.verificationUrl.startsWith("http")
    ? start.verificationUrl
    : `${options.appUrl.replace(/\/+$/, "")}${start.verificationUrl}`;
  print("");
  print("To connect this runner, open:");
  print(`  ${link}`);
  print(`and check the code: ${start.userCode}`);
  print("");
  print("Waiting for approval…");
  options.open?.(link);

  const deadline = Date.parse(start.expiresAt);
  let interval = start.interval * 1000;
  while (now() < deadline) {
    await sleep(interval);
    let answer: z.infer<typeof polled>;
    try {
      answer = polled.parse(
        await post(doFetch, `${base}${DEVICE_PATHS.poll}`, { deviceCode: start.deviceCode }),
      );
    } catch (err) {
      // A blip while waiting: back off and keep polling until the code expires.
      if (err instanceof DeviceLoginError && /answered 4\d\d/.test(err.message)) throw err;
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    if (answer.status === "pending") continue;
    if (answer.status === "approved" && answer.runnerId && answer.key) {
      return { runnerId: answer.runnerId, name: answer.name, key: answer.key };
    }
    if (answer.status === "denied") {
      throw new DeviceLoginError("The login was denied in the app. Run `sf-runner login` again.");
    }
    break;
  }
  throw new DeviceLoginError(
    `The code ${start.userCode} expired before it was approved. Run \`sf-runner login\` again.`,
  );
}
