// The gate check: actor × risk class → allow | review | deny (ADR 0004, 0008, spike ADR 0110). Policy
// is enforced here, in code, never by a prompt. An autonomy policy picks the base decision, the
// project's overrides adjust it, merge/deploy/self-modify always need review, every matching floor
// rule applies, and the strictest wins. Anything missing or malformed fails closed.
import { ACTOR_TYPES, type ActorType } from "../actors.ts";

/**
 * Risk classes (ADR 0004, amended): `plan` is accepting a spec (spike ADR 0110); a diff that touches
 * `.factory/` is `self-modify` (ADR 0036).
 */
export const RISK_CLASSES = [
  "read",
  "write",
  "plan",
  "spend",
  "outbound",
  "merge",
  "deploy",
  "self-modify",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const DECISIONS = ["allow", "review", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export const AUTONOMY_POLICIES = ["cautious", "balanced", "autonomous"] as const;
export type AutonomyPolicyName = (typeof AUTONOMY_POLICIES)[number];

/** Merge, deploy and self-modify always go to a person, for every actor and policy (ADR 0008). */
export const ALWAYS_REVIEW: readonly RiskClass[] = ["merge", "deploy", "self-modify"];

type Row = Record<RiskClass, Decision>;
type NonHuman = Exclude<ActorType, "human">;

const row = (
  read: Decision,
  write: Decision,
  plan: Decision,
  spend: Decision,
  outbound: Decision,
  merge: Decision,
  deploy: Decision,
  selfModify: Decision,
): Row => ({ read, write, plan, spend, outbound, merge, deploy, "self-modify": selfModify });

// Columns: read, write, plan, spend, outbound, merge, deploy, self-modify.
// Humans are `allow` in every policy (they are the reviewers) except ALWAYS_REVIEW; the floor can
// still restrict them.
export const AUTONOMY_TABLE: Record<AutonomyPolicyName, Record<NonHuman, Row>> = {
  cautious: {
    agent: row("allow", "review", "review", "review", "review", "review", "review", "review"),
    runner: row("allow", "allow", "deny", "review", "review", "deny", "deny", "deny"),
    intake: row("allow", "allow", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("allow", "review", "review", "deny", "review", "review", "deny", "review"),
  },
  balanced: {
    agent: row("allow", "allow", "review", "review", "review", "review", "review", "review"),
    runner: row("allow", "allow", "deny", "review", "review", "deny", "deny", "deny"),
    intake: row("allow", "allow", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("allow", "allow", "review", "deny", "review", "review", "deny", "review"),
  },
  autonomous: {
    agent: row("allow", "allow", "review", "allow", "allow", "review", "review", "review"),
    runner: row("allow", "allow", "deny", "allow", "review", "deny", "deny", "deny"),
    intake: row("allow", "allow", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("allow", "allow", "review", "review", "review", "review", "deny", "review"),
  },
};

/** actor type | "*" → risk class | "*" → decision. Used for the floor and for project overrides. */
export type DecisionRules = Partial<
  Record<ActorType | "*", Partial<Record<RiskClass | "*", Decision>>>
>;

export type FloorParse = { ok: true; floor: DecisionRules } | { ok: false; error: string };

const RANK: Record<Decision, number> = { allow: 0, review: 1, deny: 2 };
export const strictest = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

/** Validates decision rules (a floor or project overrides); returns an error message or null. */
export function rulesError(value: unknown): string | null {
  if (!isPlainObject(value)) return "rules must be an object";
  const actors: readonly string[] = [...ACTOR_TYPES, "*"];
  const risks: readonly string[] = [...RISK_CLASSES, "*"];
  for (const [actor, rules] of Object.entries(value)) {
    if (!actors.includes(actor)) return `unknown actor "${actor}"`;
    if (!isPlainObject(rules)) return `rules for "${actor}" must be an object`;
    for (const [risk, decision] of Object.entries(rules)) {
      if (!risks.includes(risk)) return `unknown risk class "${risk}"`;
      if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) {
        return `bad decision for ${actor}.${risk}`;
      }
    }
  }
  return null;
}

/** Parses the global floor (env `FACTORY_FLOOR`, JSON). Empty means no floor. */
export function parseFloor(raw: string | undefined | null): FloorParse {
  if (raw === undefined || raw === null || raw.trim() === "") return { ok: true, floor: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "floor is not JSON" };
  }
  const error = rulesError(value);
  return error
    ? { ok: false, error: `floor: ${error}` }
    : { ok: true, floor: value as DecisionRules };
}

export interface GatePolicy {
  autonomyPolicy: AutonomyPolicyName;
  overrides: DecisionRules;
}

export interface GateInput {
  actor: ActorType;
  risk: RiskClass;
  /** The project's resolved policy; `null` when it is missing or malformed (fails closed). */
  policy: GatePolicy | null;
  /** Why the policy is null, for the audit row. */
  policyError?: string;
  floor: FloorParse;
}

export interface GateResult {
  decision: Decision;
  /** Why the decision is what it is, for the audit row. */
  reason: string;
}

function lookup(rules: DecisionRules, actor: ActorType, risk: RiskClass): Decision[] {
  return [rules[actor]?.[risk], rules[actor]?.["*"], rules["*"]?.[risk], rules["*"]?.["*"]].filter(
    (d): d is Decision => d !== undefined,
  );
}

export function decide({ actor, risk, policy, policyError, floor }: GateInput): GateResult {
  if (!floor.ok) return { decision: "deny", reason: `malformed floor: ${floor.error}` };

  let decision: Decision;
  let reason: string;
  if (actor === "human") {
    decision = "allow";
    reason = "human";
  } else if (!policy) {
    return { decision: "deny", reason: `no valid autonomy policy: ${policyError ?? "missing"}` };
  } else {
    decision = AUTONOMY_TABLE[policy.autonomyPolicy][actor][risk];
    reason = `autonomy policy ${policy.autonomyPolicy}`;
    // The most specific override wins (it may loosen or tighten the shipped policy).
    const override = lookup(policy.overrides, actor, risk)[0];
    if (override && override !== decision) {
      decision = override;
      reason = `project override (${actor}.${risk})`;
    }
  }

  if (ALWAYS_REVIEW.includes(risk) && decision === "allow") {
    decision = "review";
    reason = `${risk} always needs review`;
  }

  for (const candidate of lookup(floor.floor, actor, risk)) {
    if (RANK[candidate] > RANK[decision]) {
      decision = candidate;
      reason = "floor";
    }
  }
  return { decision, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
