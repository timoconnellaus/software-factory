// Team's wording (spec 70, .kim/mockups/team-an-agent.html): each runner told simply, and what an
// agent is doing now. Pure, so the tests pin it.
import type { FlowInboxAll, FlowInboxAllItem, FlowRun } from "@software-factory/client/flow";
import { ago } from "@software-factory/client/format";
import type { OpOutput } from "@software-factory/client/ops";

type Listed = OpOutput<"runner.list">["runners"][number];

export interface RunnerRow {
  id: string;
  name: string;
  online: boolean;
  /** "Online", "Last seen 3h ago", "Never seen". */
  seen: string;
  /** Jobs it runs now, across its pools. */
  working: number;
  /** Whether it takes new work, and if not, why in a few words. */
  takesWork: { yes: boolean; why: string | null };
  /** Whether its code is the deployed commit, and if not, what is happening. */
  code: { current: boolean; text: string };
}

/**
 * One row per runner, from what it reported about itself (`runner.list`; the old core's inbox is
 * no longer read): online if it was seen in the last two minutes, working on its light pool's jobs
 * in use (where flow runs go), rate-limited until its `rateLimitedUntil`.
 */
export function runnerRows(listed: Listed[], now = Date.now()): RunnerRow[] {
  return listed.map((r) => {
    const online = r.lastSeenAt !== null && now - Date.parse(r.lastSeenAt) < 2 * 60_000;
    const working = r.light?.inUse ?? 0;
    const seen = online
      ? "Online"
      : r.lastSeenAt
        ? `Last seen ${ago(r.lastSeenAt, now)}`
        : "Never seen";
    return {
      id: r.id,
      name: r.name,
      online,
      seen,
      working,
      takesWork: takesWork(r, online, now),
      code: codeOf(r),
    };
  });
}

function takesWork(r: Listed, online: boolean, now: number): RunnerRow["takesWork"] {
  if (!online) return { yes: false, why: "offline" };
  if (!r.accepting) return { yes: false, why: "paused" };
  if (r.rateLimitedUntil && Date.parse(r.rateLimitedUntil) > now)
    return { yes: false, why: "at its Claude usage limit" };
  if (r.light && r.light.inUse >= r.light.max) return { yes: false, why: "as busy as it gets" };
  return { yes: true, why: null };
}

function codeOf(r: Listed): RunnerRow["code"] {
  const update = r.update;
  if (update?.state === "behind") return { current: false, text: "Updating" };
  if (update?.state === "blocked")
    return { current: false, text: `Can't update${update.reason ? `: ${update.reason}` : ""}` };
  if (update?.state === "rolled_back")
    return {
      current: false,
      text: `Update rolled back${update.reason ? `: ${update.reason}` : ""}`,
    };
  if (r.version && r.desiredVersion && r.version !== r.desiredVersion)
    return { current: false, text: "Out of date" };
  return { current: true, text: "Up to date" };
}

/** One of a runner's Claude accounts, as its detail shows it. */
export interface RunnerAccount {
  name: string;
  /** The one new work uses now. */
  active: boolean;
  /** Picked here, until the runner says it switched (on its next check-in). */
  switching: boolean;
  /** The last usage limit it hit, in Claude's words. */
  limit: string | null;
}

/**
 * A runner's Claude accounts (`runner.list`'s `accounts`), or null when it hasn't said (an older
 * runner). `default` is whatever `claude` is signed in as on that machine.
 */
export function runnerAccounts(r: Listed): RunnerAccount[] | null {
  const a = r.accounts;
  if (!a) return null;
  const names = a.names.includes(a.active) ? a.names : [a.active, ...a.names];
  return names.map((name) => ({
    name,
    active: name === a.active,
    switching: a.requested === name && name !== a.active,
    limit: a.limits.find((l) => l.name === name)?.message ?? null,
  }));
}

/**
 * What a person runs on the other Mac to connect it (`sf-runner login`, ADR 0056): a checkout of
 * this repository, then the login, which prints a code to type here, waits, and once approved
 * saves its key and starts the runner in the background. `--no-open`: the code is approved in this
 * app, not on the website.
 */
export const RUNNER_LOGIN_COMMAND =
  "git clone https://github.com/timoconnellaus/software-factory ~/software-factory-runner && cd ~/software-factory-runner && pnpm install --frozen-lockfile && local/runner-host/bin/sf-runner login --no-open";

/** `bcdf ghjk`, `BCDFGHJK`, `bcdf-ghjk` → `BCDF-GHJK`; null unless it is eight letters and digits. */
export function loginCode(text: string): string | null {
  const raw = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

/** What an agent is working on now: the org's items waiting on its run (`flow.inbox.all`). */
export function agentWorking(
  all: FlowInboxAll | undefined,
  orgId: string,
  agentId: string,
): FlowInboxAllItem[] {
  const org = all?.orgs.find((o) => o.orgId === orgId);
  return (org?.working ?? []).filter(
    (i) => i.waiting.on === "run" && i.waiting.agentId === agentId,
  );
}

/**
 * What `flow.agent.update` is sent for one change: in packages/client, so the contract check
 * (packages/client/test/flow-contract.test.ts) builds its input the way this screen does.
 */
export { agentUpdate } from "@software-factory/client/flow";

/** How a run ended, in a word or the error. */
export function runOutcome(run: FlowRun): { ok: boolean | null; text: string } {
  if (run.error) return { ok: false, text: run.error };
  if (run.status === "running" || run.status === "claimed" || run.status === "queued")
    return { ok: null, text: "Running" };
  if (run.status === "failed") return { ok: false, text: "Failed" };
  if (run.status === "cancelled") return { ok: null, text: "Cancelled" };
  const outcome = (run.result as { outcome?: unknown } | null | undefined)?.outcome;
  return { ok: true, text: outcome === "rejected" ? "Sent back" : "Succeeded" };
}

/** "15m 3s": how long a run took. */
export function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
