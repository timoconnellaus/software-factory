// A project's config read for the Factory section's Policy, Agents and Workflows (spec 41, slice
// 5): `config.get`'s current document, worded. Read-only: changing the config is `config.save` on the
// website, where a loosening waits for an approver (ADR 0370), so these pages link there and never
// write. The document is the stored JSON, so a field it leaves out has the schema's default; the
// defaults are here once, and a test pins them to `projectPolicySchema`. The autonomy wording comes
// from the gate itself (`decide` over `AUTONOMY_TABLE` with the project's overrides), so the page
// says what the code enforces. Code asks for a model role (ADR 0018); the Agents page shows the
// model the owner configured for a role as config, or "the default for the role". Pure.
import {
  ALWAYS_REVIEW,
  AUTONOMY_POLICIES,
  type AutonomyPolicyName,
  type Decision,
  type DecisionRules,
  decide,
  type RiskClass,
  rulesError,
} from "@software-factory/core/policy-gate";

/** The schema's defaults for the fields these pages show (test: config-view.test.ts). */
export const POLICY_DEFAULTS = {
  specRequiredFrom: "medium",
  gateHours: 72,
  questionHours: 48,
  wipLimit: 5,
  activeLimit: 10,
  shapingLimit: 5,
  releaseAgents: false,
  retryLimit: 2,
  protectionOnRed: "warn",
  improveEnabled: false,
  improveTrialSize: 5,
  improveWeeklyCap: 3,
  adjudicatorSpec: "off",
  adjudicatorStep: "off",
} as const;

/** runner-contract's MODEL_ROLES (the view doesn't depend on it): config-view.test.ts pins them. */
export const MODEL_ROLES = ["triage", "implement", "review", "summarise"] as const;

type Doc = Record<string, unknown>;
const obj = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface PolicyRow {
  key: string;
  label: string;
  value: string;
  note: string;
}

const AUTONOMY_TITLE: Record<AutonomyPolicyName, string> = {
  cautious: "Cautious",
  balanced: "Balanced",
  autonomous: "Autonomous",
};

/** What an agent may do, by the risk classes a policy chooses between (ADR 0004). */
const AGENT_RISKS: [RiskClass, string][] = [
  ["write", "writing code"],
  ["plan", "accepting a spec"],
  ["spend", "spending"],
  ["outbound", "reaching outside"],
];

const RISK_WORD: Partial<Record<RiskClass, string>> = {
  merge: "Merge",
  deploy: "deploy",
  "self-modify": "self-modify",
};

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * An agent's decisions under the project's policy and overrides, as the gate makes them before the
 * floor (`decide` with no floor): what it does on its own, what a person approves, what it never
 * does. Null when the policy names no shipped autonomy policy.
 */
export function autonomyText(doc: Doc): { title: string; text: string } | null {
  const name = doc.autonomyPolicy;
  if (!(AUTONOMY_POLICIES as readonly unknown[]).includes(name)) return null;
  const overrides = rulesError(doc.overrides ?? {}) ? {} : (doc.overrides ?? {});
  const policy = {
    autonomyPolicy: name as AutonomyPolicyName,
    overrides: overrides as DecisionRules,
  };
  const by: Record<Decision, string[]> = { allow: [], review: [], deny: [] };
  for (const [risk, words] of AGENT_RISKS) {
    const { decision } = decide({ actor: "agent", risk, policy, floor: { ok: true, floor: {} } });
    by[decision].push(words);
  }
  const text = [
    by.allow.length ? `Agents go ahead with ${list(by.allow)}.` : "Agents do nothing on their own.",
    by.review.length ? `A person approves ${list(by.review)}.` : "",
    by.deny.length ? `Agents never do ${list(by.deny)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { title: AUTONOMY_TITLE[name as AutonomyPolicyName], text };
}

/** "Merge, deploy, self-modify": what always goes to a person (ADR 0008). */
export const ALWAYS_A_PERSON = ALWAYS_REVIEW.map((r) => RISK_WORD[r] ?? r).join(", ");

const hours = (h: number) => (h % 24 === 0 ? `${h / 24} ${h === 24 ? "day" : "days"}` : `${h} h`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The rules the factory can't talk its way around, grouped as the design groups them. */
export function policySections(doc: Doc): { title: string; rows: PolicyRow[] }[] {
  const autonomy = autonomyText(doc);
  const spec = str(obj(doc.spec).requiredFrom, POLICY_DEFAULTS.specRequiredFrom);
  const timeouts = obj(doc.timeouts);
  const improve = obj(doc.improve);
  const adjudicator = obj(doc.adjudicator);
  const approvers = arr(doc.approvers).filter((a): a is string => typeof a === "string");
  const backup = typeof doc.backupOwner === "string" ? doc.backupOwner : null;
  const overrides = Object.entries(obj(doc.overrides)).flatMap(([actor, rules]) =>
    Object.entries(obj(rules)).map(([risk, d]) => `${actor} ${risk}: ${String(d)}`),
  );
  const releaseAgents = bool(obj(doc.release).agents, POLICY_DEFAULTS.releaseAgents);
  const onRed = str(obj(doc.protection).onRed, POLICY_DEFAULTS.protectionOnRed);
  return [
    {
      title: "Autonomy",
      rows: [
        {
          key: "autonomy",
          label: "Autonomy policy",
          value: autonomy?.title ?? str(doc.autonomyPolicy, "not set"),
          note: autonomy?.text ?? "",
        },
        {
          key: "release",
          label: "Release from Ready",
          value: releaseAgents ? "People, agents and chat" : "People only",
          note: releaseAgents
            ? "Agents, intakes and chat may release work too."
            : "Agents, intakes and chat can add to the backlog but not release.",
        },
        {
          key: "spec",
          label: "Spec approval",
          value: spec === "small" ? "Needed for every item" : `Needed from ${spec} up`,
          note: spec === "small" ? "" : "Smaller items skip the spec gate.",
        },
        {
          key: "merge",
          label: ALWAYS_A_PERSON,
          value: "Always a person",
          note: "Fixed for every policy. No setting changes it.",
        },
        {
          key: "floor",
          label: "The factory's floor",
          value: "Can only tighten this",
          note: "A floor set for the whole factory applies on top of the project's policy and may make any of these stricter. The app can't read it yet.",
        },
        {
          key: "overrides",
          label: "Overrides",
          value: overrides.length ? plural(overrides.length, "rule") : "None",
          note: overrides.join(" · "),
        },
      ],
    },
    {
      title: "Limits",
      rows: [
        {
          key: "wip",
          label: "Waiting on you",
          value: `At most ${plural(num(doc.wipLimit, POLICY_DEFAULTS.wipLimit), "item")}`,
          note: "When full, new builds stop until a gate is decided.",
        },
        {
          key: "active",
          label: "In the pipeline",
          value: `At most ${plural(num(doc.activeLimit, POLICY_DEFAULTS.activeLimit), "item")}`,
          note: "Queued work is pulled while the project is under it.",
        },
        {
          key: "shaping",
          label: "Shaping at once",
          value: `At most ${plural(num(doc.shapingLimit, POLICY_DEFAULTS.shapingLimit), "item")}`,
          note: "So shaping can't crowd out released work.",
        },
        {
          key: "retry",
          label: "Retries per item",
          value: String(num(doc.retryLimit, POLICY_DEFAULTS.retryLimit)),
          note: "Automatic retries of a failed build or verify, then the item fails.",
        },
      ],
    },
    {
      title: "People and time",
      rows: [
        {
          key: "approvers",
          label: "Approvers",
          value: approvers.length ? approvers.join(", ") : "The org's owners and admins",
          note: "Who decides gates.",
        },
        {
          key: "backup",
          label: "Backup owner",
          value: backup ?? (approvers[0] ? approvers[0] : "The first approver"),
          note: "Gets a gate or question that times out.",
        },
        {
          key: "gate-timeout",
          label: "Gate timeout",
          value: hours(num(timeouts.gateHours, POLICY_DEFAULTS.gateHours)),
          note: "Then it goes to the backup owner. Never accepted on its own.",
        },
        {
          key: "question-timeout",
          label: "Question timeout",
          value: hours(num(timeouts.questionHours, POLICY_DEFAULTS.questionHours)),
          note: "",
        },
      ],
    },
    {
      title: "Safeguards",
      rows: [
        {
          key: "protection",
          label: "When protection on main is red",
          value: onRed === "block" ? "Hold builds" : "Warn",
          note: "",
        },
        {
          key: "improve",
          label: "Self-improvement",
          value: bool(improve.enabled, POLICY_DEFAULTS.improveEnabled)
            ? `On: trials on ${plural(num(improve.trialSize, POLICY_DEFAULTS.improveTrialSize), "item")}, at most ${num(improve.weeklyCap, POLICY_DEFAULTS.improveWeeklyCap)} a week`
            : "Off",
          note: "Practice changes only, rolled back automatically. Never policy.",
        },
        {
          key: "adjudicator",
          label: "Adjudicator",
          value: `Spec ${str(adjudicator.spec, POLICY_DEFAULTS.adjudicatorSpec)} · steps ${str(adjudicator.step, POLICY_DEFAULTS.adjudicatorStep)}`,
          note: "Never merges, deploys or self-modifies.",
        },
      ],
    },
  ];
}

export interface AgentRow {
  name: string;
  role: string;
  tier: "standard" | "light";
  instructions: string;
  lines: number;
  requires: string[];
  /** Workflow steps (and builds) that hand to it. */
  usedBy: string[];
}

/** The project's agents (ADR 0372), with where its workflows use each. */
export function agentRows(doc: Doc): AgentRow[] {
  const uses = new Map<string, string[]>();
  for (const w of workflowList(doc)) {
    if (w.build)
      uses.set(w.build.toLowerCase(), [
        ...(uses.get(w.build.toLowerCase()) ?? []),
        `${w.name}: build`,
      ]);
    for (const slot of w.slots) {
      for (const s of slot.steps) {
        if (s.kind === "work") {
          const k = s.who.toLowerCase();
          uses.set(k, [...(uses.get(k) ?? []), `${w.name}: ${s.name}`]);
        }
      }
    }
  }
  return arr(doc.agents).map((a) => {
    const o = obj(a);
    const name = str(o.name, "Unnamed");
    const instructions = str(o.instructions, "");
    return {
      name,
      role: str(o.role, "implement"),
      tier: o.tier === "light" ? "light" : "standard",
      instructions,
      lines: instructions ? instructions.trim().split("\n").length : 0,
      requires: arr(o.requires).filter((r): r is string => typeof r === "string"),
      usedBy: uses.get(name.toLowerCase()) ?? [],
    };
  });
}

/** Each model role and tier with the project's choice; null means the default for the role. */
export function modelRoleRows(
  doc: Doc,
): { role: string; standard: string | null; light: string | null }[] {
  const chosen = obj(doc.modelRoles);
  const pick = (k: string) => (typeof chosen[k] === "string" ? (chosen[k] as string) : null);
  return MODEL_ROLES.map((role) => ({
    role,
    standard: pick(role),
    light: pick(`${role}.light`),
  }));
}

export interface StepView {
  id: string;
  kind: "work" | "gate";
  name: string;
  /** Who does it: the agent for work, the approver (or "Approvers") for a gate. */
  who: string;
  when: string | null;
}

export interface WorkflowView {
  name: string;
  description: string;
  build: string | null;
  slots: { slot: "afterSpec" | "beforeVerify" | "afterVerify"; label: string; steps: StepView[] }[];
  stepCount: number;
  current: boolean;
}

const SLOT_LABEL = {
  afterSpec: "After the spec",
  beforeVerify: "Before verify",
  afterVerify: "After verify",
} as const;

/** The project's named workflows (ADR 0371); `current` is the one it runs (ADR 0492). */
export function workflowList(doc: Doc): WorkflowView[] {
  const chosen = typeof doc.workflow === "string" ? doc.workflow.toLowerCase() : null;
  return arr(doc.workflows).map((w) => {
    const o = obj(w);
    const slots = obj(o.slots);
    const name = str(o.name, "Unnamed");
    const views = (["afterSpec", "beforeVerify", "afterVerify"] as const).map((slot) => ({
      slot,
      label: SLOT_LABEL[slot],
      steps: arr(slots[slot]).map((s) => {
        const st = obj(s);
        const when = obj(st.when);
        const kind = st.kind === "gate" ? "gate" : "work";
        const conds = [
          typeof when.sizeAtLeast === "string" ? `${when.sizeAtLeast} and up` : null,
          typeof when.domain === "string" ? `touching ${when.domain}` : null,
        ].filter(Boolean);
        return {
          id: str(st.id, ""),
          kind,
          name: str(st.name, "Unnamed step"),
          who:
            kind === "gate"
              ? typeof st.approver === "string"
                ? st.approver
                : "Approvers"
              : str(st.agent, "an agent"),
          when: conds.length ? conds.join(", ") : null,
        } satisfies StepView;
      }),
    }));
    return {
      name,
      description: str(o.description, ""),
      build: typeof obj(o.core).build === "string" ? (obj(o.core).build as string) : null,
      slots: views,
      stepCount: views.reduce((n, s) => n + s.steps.length, 0),
      current: chosen !== null && name.toLowerCase() === chosen,
    };
  });
}

/** The fixed skeleton's stages around the slots (ADR 0371): what each does and who lets it through. */
export function skeleton(doc: Doc, w: WorkflowView | null) {
  const spec = str(obj(doc.spec).requiredFrom, POLICY_DEFAULTS.specRequiredFrom);
  return [
    {
      stage: "Spec",
      does: "Works out the spec and its acceptance criteria.",
      through:
        spec === "small"
          ? "A person approves every spec."
          : `A person approves the spec from ${spec} up; smaller items skip it.`,
      decides: "person" as const,
      after: w?.slots[0] ?? null,
    },
    {
      stage: "Build",
      does: w?.build ? `${w.build} implements the spec.` : "The builder implements the spec.",
      through: "The build finishes and the pull request is up to date.",
      decides: "code" as const,
      after: w?.slots[1] ?? null,
    },
    {
      stage: "Verify",
      does: "Checks the head against the acceptance criteria, with an independent reviewer.",
      through: "factory/verify passes on the head.",
      decides: "code" as const,
      after: w?.slots[2] ?? null,
    },
    {
      stage: "Review",
      does: "A person reads the review packet.",
      through: "A person merges. Sending back returns it to build.",
      decides: "person" as const,
      after: null,
    },
    {
      stage: "Merge",
      does: "Lands approved work one at a time and runs CI on the merged head.",
      through: "CI is green on the merged head.",
      decides: "code" as const,
      after: null,
    },
  ];
}

/** "Version 12, from the app, by owner." */
export function versionLine(
  current: {
    version: number | null;
    source: string | null;
    createdBy: string | null;
  } | null,
): string {
  if (!current) return "No config yet.";
  const parts = [current.version !== null ? `Version ${current.version}` : "The policy file"];
  if (current.source) parts.push(`from ${current.source}`);
  if (current.createdBy) parts.push(`by ${current.createdBy}`);
  return `${parts.join(", ")}.`;
}

/**
 * The project the config pages show: among the rail's org's projects, `?project=`, else the first.
 * The page and its loader both choose with it, so the loader reads the config the page shows.
 */
export function configProject<P extends { id: string; orgId: string }>(
  projects: P[],
  orgId: string | null,
  chosen: string | undefined,
): { inScope: P[]; project: P | null } {
  const inScope = projects.filter((p) => orgId === null || p.orgId === orgId);
  return { inScope, project: inScope.find((p) => p.id === chosen) ?? inScope[0] ?? null };
}
