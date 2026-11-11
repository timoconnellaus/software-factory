// The gate: actor × risk class → auto | review | deny. Policy is enforced here, in code, never by
// a prompt. Same shape as the CRM's gate (its ADR 0018): a preset picks the base decision, every
// matching floor rule applies, the strictest wins, and anything malformed fails closed.

export const ACTOR_TYPES = ["human", "agent", "runner", "intake", "self-improve"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Risk classes from the research doc, plus `plan` (accepting a spec), which the plan's spec gate
 * needs: without it, a spec acceptance is a plain `write` and Balanced would never pause on it.
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

export const DECISIONS = ["auto", "review", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export const PRESETS = ["cautious", "balanced", "autonomous"] as const;
export type PresetName = (typeof PRESETS)[number];

/** Merge, deploy and self-modify always go to a human, whatever the preset says. */
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
// Humans are `auto` in every preset (they are the reviewers); the floor can still restrict them.
export const PRESET_TABLE: Record<PresetName, Record<NonHuman, Row>> = {
  cautious: {
    agent: row("auto", "review", "review", "review", "review", "review", "review", "review"),
    runner: row("auto", "auto", "deny", "review", "review", "deny", "deny", "deny"),
    intake: row("auto", "auto", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("auto", "review", "review", "deny", "review", "review", "deny", "review"),
  },
  balanced: {
    agent: row("auto", "auto", "review", "review", "review", "review", "review", "review"),
    runner: row("auto", "auto", "deny", "review", "review", "deny", "deny", "deny"),
    intake: row("auto", "auto", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("auto", "auto", "review", "deny", "review", "review", "deny", "review"),
  },
  autonomous: {
    agent: row("auto", "auto", "auto", "auto", "auto", "review", "review", "review"),
    runner: row("auto", "auto", "deny", "auto", "review", "deny", "deny", "deny"),
    intake: row("auto", "auto", "deny", "deny", "deny", "deny", "deny", "deny"),
    "self-improve": row("auto", "auto", "review", "review", "review", "review", "deny", "review"),
  },
};

/** actor type | "*" → risk class | "*" → decision. */
export type Floor = Partial<Record<ActorType | "*", Partial<Record<RiskClass | "*", Decision>>>>;

export type FloorParse = { ok: true; floor: Floor } | { ok: false; error: string };

const RANK: Record<Decision, number> = { auto: 0, review: 1, deny: 2 };
export const strictest = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

/** Parses the floor (env `APPROVAL_FLOOR`). Empty means no floor; anything else must be exact. */
export function parseFloor(raw: string | undefined | null): FloorParse {
  if (raw === undefined || raw === null || raw.trim() === "") return { ok: true, floor: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "floor is not JSON" };
  }
  if (!isPlainObject(value)) return { ok: false, error: "floor must be an object" };
  const actors: readonly string[] = [...ACTOR_TYPES, "*"];
  const risks: readonly string[] = [...RISK_CLASSES, "*"];
  const decisions: readonly string[] = DECISIONS;
  for (const [actor, rules] of Object.entries(value)) {
    if (!actors.includes(actor)) return { ok: false, error: `unknown actor "${actor}"` };
    if (!isPlainObject(rules))
      return { ok: false, error: `rules for "${actor}" must be an object` };
    for (const [risk, decision] of Object.entries(rules)) {
      if (!risks.includes(risk)) return { ok: false, error: `unknown risk class "${risk}"` };
      if (typeof decision !== "string" || !decisions.includes(decision)) {
        return { ok: false, error: `bad decision for ${actor}.${risk}` };
      }
    }
  }
  return { ok: true, floor: value as Floor };
}

/** An unknown or missing preset is treated as the strictest one. */
export function parsePreset(raw: string | undefined | null): PresetName {
  return (PRESETS as readonly string[]).includes(raw ?? "") ? (raw as PresetName) : "cautious";
}

export interface GateInput {
  actor: ActorType;
  risk: RiskClass;
  preset: PresetName;
  floor: FloorParse;
}

export interface GateResult {
  decision: Decision;
  /** Why the decision is what it is, for the audit row. */
  reason: string;
}

export function decide({ actor, risk, preset, floor }: GateInput): GateResult {
  if (!floor.ok) return { decision: "deny", reason: `malformed floor: ${floor.error}` };

  let decision: Decision = actor === "human" ? "auto" : PRESET_TABLE[preset][actor][risk];
  let reason = `preset ${preset}`;

  if (actor !== "human" && ALWAYS_REVIEW.includes(risk) && decision === "auto") {
    decision = "review";
    reason = `${risk} always needs review`;
  }

  const rules = floor.floor;
  for (const candidate of [
    rules[actor]?.[risk],
    rules[actor]?.["*"],
    rules["*"]?.[risk],
    rules["*"]?.["*"],
  ]) {
    if (candidate && RANK[candidate] > RANK[decision]) {
      decision = candidate;
      reason = "floor";
    }
  }
  return { decision, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
