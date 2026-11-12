// The status bar's wording (spec 41): runners, slots, running, waiting and the sync state, from
// the inbox read and the query's own timestamps. Pure, so the tests pin it. No budget and no update
// notice: main has no data for them yet (spec 41, slice 6).
import type { Inbox } from "@software-factory/client/ops";
import { RUNNER_DOT } from "@software-factory/client/runners";
import type { Status } from "@software-factory/ui/components/status-dot";

type Runner = Inbox["runners"][number];

const RUNNER_WORD: Record<Runner["state"], string> = {
  online: "online",
  busy: "busy",
  "rate-limited": "rate-limited",
  offline: "offline",
  draining: "draining",
};

export function runnerItems(runners: Runner[]): { id: string; text: string; status: Status }[] {
  return runners.map((r) => ({
    id: r.id,
    text: `${r.name} ${RUNNER_WORD[r.state]}`,
    status: RUNNER_DOT[r.state],
  }));
}

/** "Heavy 1 of 2" and "Light 2 of 6", over the runners that are up. Light only when reported. */
export function slots(runners: Runner[]): { heavy: string | null; light: string | null } {
  const up = runners.filter((r) => r.state !== "offline");
  if (up.length === 0) return { heavy: null, light: null };
  const heavyUsed = up.reduce((n, r) => n + r.inUse, 0);
  const heavyMax = up.reduce((n, r) => n + r.max, 0);
  const lights = up.flatMap((r) => (r.light ? [r.light] : []));
  return {
    heavy: `Heavy ${heavyUsed} of ${heavyMax}`,
    light: lights.length
      ? `Light ${lights.reduce((n, l) => n + l.inUse, 0)} of ${lights.reduce((n, l) => n + l.max, 0)}`
      : null,
  };
}

export const runningCount = (inbox: Pick<Inbox, "running">) =>
  inbox.running.filter((i) => i.status === "running").length;

/** When the app last heard from the factory, or that it can't reach it. */
export function syncText(
  q: { dataUpdatedAt: number; isError: boolean; errorUpdatedAt: number },
  now = Date.now(),
): { text: string; ok: boolean } {
  if (q.isError && q.errorUpdatedAt >= q.dataUpdatedAt) {
    return { text: "Can't reach the factory", ok: false };
  }
  if (!q.dataUpdatedAt) return { text: "Syncing…", ok: true };
  const s = Math.max(0, Math.round((now - q.dataUpdatedAt) / 1000));
  if (s < 45) return { text: "Synced just now", ok: true };
  const m = Math.round(s / 60);
  if (m < 60) return { text: `Synced ${m} min ago`, ok: true };
  return { text: `Synced ${Math.round(m / 60)} h ago`, ok: true };
}
