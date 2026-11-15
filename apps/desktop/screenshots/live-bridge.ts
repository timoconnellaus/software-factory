// The live harness's stand-in for src/mainview/bridge.ts (live.mjs, vite.config.ts in mode `live`):
// the fixture door for everything about this Mac (the device key, the updater, the runner card,
// the window's chrome), but operations go to the real engine through live.mjs's dev server, which
// adds the CLI's token on the way. The page never sees the token: it posts to `/__live/*` on its own
// origin, and the server forwards.
import type { CallResult, Session } from "../src/shared/rpc.ts";
import { bun as fake } from "./fake-bridge.ts";

export * from "./fake-bridge.ts";

/** Requests in flight to the engine: live.mjs waits for none before a shot. */
let pending = 0;
const live = window as { __sfLivePending?: () => number };
live.__sfLivePending = () => pending;

async function post<T>(path: string, body: unknown): Promise<T> {
  pending++;
  try {
    const res = await fetch(`/__live/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  } finally {
    pending--;
  }
}

type Call = { op: string; input: unknown; idempotencyKey?: string };

export const bun = {
  ...fake,
  /** This Mac's session (the fixture's), signed in as the CLI token's person on its engine. */
  session: async (): Promise<Session> => ({
    ...(await fake.session()),
    ...(await post<Pick<Session, "login" | "engineUrl">>("session", {})),
  }),
  call: (p: Call) => post<CallResult>("call", p),
  batch: (p: { calls: { op: string; input: unknown }[] }) => post<CallResult[]>("batch", p),
  decide: (p: Call) => post<CallResult>("decide", p),
};
