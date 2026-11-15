// Team's wording (spec 70, .kim/mockups/team-an-agent.html): each runner told simply, and what an
// agent is doing now. Pure, so the tests pin it.
import type {
  FlowAgent,
  FlowInboxAll,
  FlowInboxAllItem,
  FlowRun,
} from "@software-factory/client/flow";
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
    return { yes: false, why: "rate-limited" };
  if (r.light && r.light.inUse >= r.light.max) return { yes: false, why: "full" };
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
 * What `flow.agent.update` is sent for one change: it takes the whole agent, so its name and saved
 * instructions go with it, and its `mcp` (missing reads as none). The Plugin editor is `factory`.
 */
export function agentUpdate(
  orgId: string,
  agent: Pick<FlowAgent, "id" | "name" | "instructions" | "mcp">,
  change: { instructions?: string; pluginEditor?: boolean },
) {
  const mcp =
    change.pluginEditor === undefined
      ? (agent.mcp ?? [])
      : change.pluginEditor
        ? ["factory"]
        : (agent.mcp ?? []).filter((m) => m !== "factory");
  return {
    orgId,
    agentId: agent.id,
    name: agent.name,
    instructions: change.instructions ?? agent.instructions,
    mcp,
  };
}

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
