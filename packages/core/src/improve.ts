// The improver (ADR 0373, spec 09 M3): signals from finished work, a drafted practice change, and the
// comparison that promotes or disables a trial. Pure where it can be; the operations in
// operations/improve.ts read the signals and write the trials.
//
// V1 drafts with two rules, not a model: it tightens the builder's instructions when the same check
// keeps failing verify (effectiveness), and moves the builder to the light tier when recent items
// all passed first time (efficiency). Each change is practice only (the default builder's tier and
// instructions), and is trialled, never applied outright.
import type { Db } from "@software-factory/db";
import type { ProjectPolicy } from "./policy/project-policy.ts";

/** An implement agent with this name builds items whose workflow names no builder (ADR 0372). */
export const DEFAULT_BUILDER = "Builder";

/** One finished work item, as the improver measures it. */
export interface ItemOutcome {
  id: string;
  policySha: string | null;
  trialId: string | null;
  done: boolean;
  /** Failed or sent-back rounds (verify failures, send-backs at review, failed runs). */
  rounds: number;
  /** Check names that failed in its failed review packets. */
  failingChecks: string[];
  /** Tokens across its runs (input + output), from the usage artifacts. */
  tokens: number;
  finishedAt: string;
}

/** The project's most recently finished change items (newest first). */
export async function recentOutcomes(
  db: Db,
  projectId: string,
  opts: { limit: number; policySha?: string; trialId?: string; since?: string },
): Promise<ItemOutcome[]> {
  let q = db
    .selectFrom("core_work_items")
    .select(["id", "policy_sha", "trial_id", "status", "updated_at"])
    .where("project_id", "=", projectId)
    .where("kind", "=", "change")
    .where("status", "in", ["done", "failed", "rejected"]);
  if (opts.policySha) q = q.where("policy_sha", "=", opts.policySha).where("trial_id", "is", null);
  if (opts.trialId) q = q.where("trial_id", "=", opts.trialId);
  if (opts.since) q = q.where("created_at", ">=", opts.since);
  const items = await q.orderBy("updated_at", "desc").limit(opts.limit).execute();
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const [stages, packets, usage] = await Promise.all([
    db
      .selectFrom("core_stages")
      .select(["work_item_id", "status"])
      .where("work_item_id", "in", ids)
      .where("status", "in", ["failed", "sent_back"])
      .execute(),
    db
      .selectFrom("core_review_packets")
      .select(["work_item_id", "checks"])
      .where("work_item_id", "in", ids)
      .where("verdict", "=", "fail")
      .execute(),
    db
      .selectFrom("core_artifacts as a")
      .innerJoin("core_runs as r", "r.id", "a.run_id")
      .select(["r.work_item_id", "a.meta"])
      .where("r.work_item_id", "in", ids)
      .where("a.kind", "=", "usage")
      .execute(),
  ]);
  return items.map((i) => {
    const failing = packets
      .filter((p) => p.work_item_id === i.id)
      .flatMap((p) => {
        try {
          return (JSON.parse(p.checks) as { name?: string; status?: string }[])
            .filter((c) => c.status === "fail" && c.name)
            .map((c) => String(c.name).toLowerCase());
        } catch {
          return [];
        }
      });
    const tokens = usage
      .filter((u) => u.work_item_id === i.id)
      .reduce((sum, u) => {
        try {
          const entries =
            (JSON.parse(u.meta) as { entries?: { inputTokens?: number; outputTokens?: number }[] })
              .entries ?? [];
          return (
            sum + entries.reduce((s, e) => s + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0)
          );
        } catch {
          return sum;
        }
      }, 0);
    return {
      id: i.id,
      policySha: i.policy_sha,
      trialId: i.trial_id,
      done: i.status === "done",
      rounds: stages.filter((s) => s.work_item_id === i.id).length,
      failingChecks: [...new Set(failing)],
      tokens,
      finishedAt: i.updated_at,
    };
  });
}

export interface Candidate {
  kind: "instructions" | "tier";
  summary: string;
  evidence: Record<string, unknown>;
  policy: Record<string, unknown>;
}

const MIN_ITEMS = 5;

/**
 * Drafts at most one practice change from recent outcomes, or null. `tried` lists the summaries of
 * trials disabled lately, so a change that didn't hold up isn't tried again straight away.
 */
export function draftCandidate(
  doc: Record<string, unknown>,
  policy: ProjectPolicy,
  recent: ItemOutcome[],
  tried: string[],
): Candidate | null {
  if (recent.length < MIN_ITEMS) return null;
  const builder = policy.agents.find(
    (a) => a.name.toLowerCase() === DEFAULT_BUILDER.toLowerCase() && a.role === "implement",
  );
  const withBuilder = (patch: { tier?: "standard" | "light"; addInstruction?: string }) => {
    const next = structuredClone(doc);
    const agents = (Array.isArray(next.agents) ? next.agents : []) as Record<string, unknown>[];
    let agent = agents.find((a) => String(a.name).toLowerCase() === DEFAULT_BUILDER.toLowerCase());
    if (!agent) {
      agent = { name: DEFAULT_BUILDER, role: "implement", tier: "standard", instructions: "" };
      agents.push(agent);
    }
    if (patch.tier) agent.tier = patch.tier;
    if (patch.addInstruction) {
      const prior = typeof agent.instructions === "string" ? agent.instructions.trim() : "";
      agent.instructions = prior ? `${prior}\n${patch.addInstruction}` : patch.addInstruction;
    }
    next.agents = agents;
    return next;
  };

  // Effectiveness first: the same check failing verify again and again.
  const counts = new Map<string, number>();
  for (const item of recent.slice(0, 10)) {
    for (const check of item.failingChecks) counts.set(check, (counts.get(check) ?? 0) + 1);
  }
  const [check, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (check && times >= 2) {
    const line = `Before you finish, run the project's ${check} and fix everything it reports.`;
    const summary = `Tell the builder to run ${check} before finishing`;
    if (!builder?.instructions.includes(line) && !tried.includes(summary)) {
      return {
        kind: "instructions",
        summary,
        evidence: { check, failedItems: times, of: Math.min(recent.length, 10) },
        policy: withBuilder({ addInstruction: line }),
      };
    }
  }

  // Efficiency: everything recent passed first time on the standard tier.
  const last = recent.slice(0, MIN_ITEMS);
  if ((builder?.tier ?? "standard") === "standard" && last.every((i) => i.done && i.rounds === 0)) {
    const summary = "Build on the light tier";
    if (!tried.includes(summary)) {
      return {
        kind: "tier",
        summary,
        evidence: {
          items: last.length,
          allPassedFirstTime: true,
          tokensPerItem: Math.round(last.reduce((s, i) => s + i.tokens, 0) / last.length),
        },
        policy: withBuilder({ tier: "light" }),
      };
    }
  }
  return null;
}

export interface TrialOutcome {
  decision: "promote" | "disable" | "wait";
  reason: string;
  trial: { items: number; doneRate: number; rounds: number; tokens: number };
  base: { items: number; doneRate: number; rounds: number; tokens: number } | null;
}

function measure(items: ItemOutcome[]) {
  const n = items.length;
  return {
    items: n,
    doneRate: n ? items.filter((i) => i.done).length / n : 0,
    rounds: n ? items.reduce((s, i) => s + i.rounds, 0) / n : 0,
    tokens: n ? Math.round(items.reduce((s, i) => s + i.tokens, 0) / n) : 0,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Decides a trial (ADR 0373): outcomes must hold up (items done at least as often, failed rounds no
 * more than before); a trial with no baseline to compare must have every item done in at most one
 * round. Waits until `target` items finished, or decides on what there is once it's `expired`.
 */
export function evaluateTrial(
  trialItems: ItemOutcome[],
  baseItems: ItemOutcome[],
  target: number,
  expired: boolean,
): TrialOutcome {
  const trial = measure(trialItems);
  const base = baseItems.length ? measure(baseItems) : null;
  if (trial.items < target && !(expired && trial.items > 0)) {
    return {
      decision: "wait",
      reason: `${trial.items} of ${target} items finished`,
      trial,
      base,
    };
  }
  if (!base) {
    const ok = trial.doneRate === 1 && trial.rounds <= 1;
    return {
      decision: ok ? "promote" : "disable",
      reason: ok
        ? `all ${trial.items} items done, ${trial.rounds.toFixed(1)} failed rounds each (no earlier items to compare)`
        : `${pct(trial.doneRate)} of ${trial.items} items done, ${trial.rounds.toFixed(1)} failed rounds each (no earlier items to compare)`,
      trial,
      base,
    };
  }
  const holds = trial.doneRate >= base.doneRate && trial.rounds <= base.rounds;
  const tokens =
    base.tokens > 0 && trial.tokens > 0 ? `; tokens per item ${base.tokens} → ${trial.tokens}` : "";
  return {
    decision: holds ? "promote" : "disable",
    reason: `${holds ? "held up" : "did worse"}: done ${pct(base.doneRate)} → ${pct(trial.doneRate)}, failed rounds per item ${base.rounds.toFixed(1)} → ${trial.rounds.toFixed(1)}${tokens}`,
    trial,
    base,
  };
}
