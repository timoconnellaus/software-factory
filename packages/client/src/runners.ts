// The runner health line's words (spec 12, ADR 0360): online, busy n/cap, rate-limited until T,
// offline since T, and how the runner's code stands. Shared by sf-app and the desktop app.
import type { Status } from "@software-factory/ui/components/status-dot";
import { ago, clock } from "./format.ts";
import type { Inbox } from "./ops.ts";

export type Runner = Inbox["runners"][number];

export const RUNNER_DOT: Record<Runner["state"], Status> = {
  online: "done",
  busy: "running",
  "rate-limited": "waiting",
  offline: "failed",
  draining: "idle",
};

/** How the runner's code stands (ADR 0360), or "" when it's current. */
export function updateLabel(r: Runner): string {
  if (!r.update) return "";
  if (r.update.state === "behind") return "updating to the latest version";
  const what = r.update.state === "blocked" ? "can't update" : "update rolled back";
  return r.update.reason ? `${what}: ${r.update.reason}` : what;
}

export function runnerLabel(r: Runner): string {
  // With a light pool (ADR 0301): "heavy 1/2 · light 2/6".
  const slots = r.light
    ? `heavy ${r.inUse}/${r.max} · light ${r.light.inUse}/${r.light.max}`
    : `${r.inUse}/${r.max}`;
  switch (r.state) {
    case "online":
      return `online · ${slots}`;
    case "busy":
      return r.light ? `busy · ${slots}` : `busy ${slots}`;
    case "rate-limited":
      return r.rateLimitedUntil
        ? `rate-limited until ${clock(r.rateLimitedUntil)}`
        : "rate-limited";
    case "offline":
      return r.lastSeenAt
        ? `offline since ${clock(r.lastSeenAt)} (${ago(r.lastSeenAt)})`
        : "offline · never seen";
    case "draining":
      return `draining · ${slots}`;
  }
}

