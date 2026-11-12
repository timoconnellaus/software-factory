// Spec 52, build plan PR (a): today's path expressed as stage lists changes nothing. Each part of
// the comparison is against the code that runs today:
// - the slot plan: `planWorkflow()` (the Workflow's own), for a table of configs, sizes and domains;
// - the spec gate: `specRequired()` (what `workItem.triage` records) for every threshold, size and
//   foreman request, and an attached PR's skip (the triage handler's `kind === "attached"` branch);
// - every gate under every autonomy policy: the operation the Workflow opens it with, decided by the
//   real gate (`decide()` on the registry operation's risk, `riskOf` and `alwaysReview`, as invoke
//   does) against the stage type's gate spec;
// - the phases: `STAGE_PHASE` for a change; incidents and attached PRs are opened queued, so nothing
//   of theirs shapes;
// - the stages a run passes and skips: the `core_stages` rows the Workflow writes, in
//   `workflow.test.ts` (a small change) and `attach-flow.test.ts` (an attached PR), which assert
//   `engineStages()` of the compiled definition.
import {
  ALWAYS_REVIEW,
  AUTONOMY_POLICIES,
  type AutonomyPolicyName,
  type DecisionRules,
  decide,
  getOperation,
  type ProjectPolicy,
  parseProjectPolicy,
  type RiskClass,
  STAGE_PHASE,
  specRequired,
} from "@software-factory/core";
import {
  CompileError,
  compileItemWorkflow,
  compileProjectWorkflow,
  engineStages,
  planFromDefinition,
  SIZES as STAGE_SIZES,
  specGateHolds,
  stageType,
  validateWorkflow,
} from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import { planWorkflow } from "../src/workflow/work-item.ts";

const AGENTS = [
  { name: "Builder", role: "implement", tier: "light", instructions: "Run pnpm test first." },
  { name: "Fast builder", role: "implement", tier: "light", instructions: "" },
  {
    name: "Security",
    role: "review",
    tier: "light",
    instructions: "Look hard at auth.",
    requires: ["browser"],
  },
  { name: "Notes", role: "summarise", tier: "standard", instructions: "" },
];

const CONFIGS: Record<string, object> = {
  "no workflow, no agents": {},
  "no workflow, the default builder": { agents: AGENTS },
  "slots in every position": {
    agents: AGENTS,
    workflows: [
      {
        name: "Ship a feature",
        description: "New behaviour",
        slots: {
          afterSpec: [
            {
              id: "design",
              kind: "gate",
              name: "Design",
              approver: "octocat",
              instructions: "Check the mockups.",
            },
          ],
          beforeVerify: [
            {
              id: "security",
              kind: "work",
              name: "Security review",
              agent: "Security",
              when: { domain: "auth" },
            },
            { id: "notes", kind: "work", name: "Release notes", agent: "Notes" },
          ],
          afterVerify: [
            { id: "sign-off", kind: "gate", name: "Sign-off", when: { sizeAtLeast: "large" } },
          ],
        },
        core: { build: "Fast builder" },
      },
    ],
    workflow: "Ship a feature",
  },
  "a workflow whose builder isn't an implementer": {
    agents: AGENTS,
    workflows: [{ name: "Odd", core: {} }],
    workflow: "Odd",
  },
};

const SIZES = ["small", "medium", "large", null] as const;
const DOMAINS = [[], ["auth"], ["billing", "auth"]];

describe("the compiled Software definition plans exactly as Workflow v7 does", () => {
  for (const [what, extra] of Object.entries(CONFIGS)) {
    it(what, () => {
      const parsed = parseProjectPolicy(
        JSON.stringify({ version: 1, autonomyPolicy: "balanced", ...extra }),
      );
      if (!parsed.ok) throw new Error(parsed.error);
      const policy = parsed.policy;
      const def = compileProjectWorkflow(policy, policy.workflow);
      expect(validateWorkflow(def, { agents: policy.agents }).valid).toBe(true);
      for (const size of SIZES) {
        for (const domains of DOMAINS) {
          const today = planWorkflow(policy, policy.workflow, size, JSON.stringify(domains));
          const fromDef = planFromDefinition(
            def,
            policy.agents,
            size,
            domains,
            today?.name ?? null,
          );
          expect(fromDef).toEqual(today);
        }
      }
    });
  }
});

const KINDS = ["change", "incident", "attached"] as const;
const REQUESTS = [undefined, "skip", "require"] as const;

function policyOf(extra: object): ProjectPolicy {
  const parsed = parseProjectPolicy(
    JSON.stringify({ version: 1, autonomyPolicy: "balanced", ...extra }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.policy;
}

describe("the spec gate from the definition is the one triage records", () => {
  for (const requiredFrom of STAGE_SIZES) {
    it(`spec required from ${requiredFrom}`, () => {
      const policy = policyOf({ spec: { requiredFrom } });
      for (const kind of KINDS) {
        const def = compileItemWorkflow(policy, null, kind);
        for (const size of STAGE_SIZES) {
          for (const requested of REQUESTS) {
            // workItem.triage: an attached PR skips the spec whatever its size; anything else asks
            // specRequired().
            const today =
              kind === "attached" ? false : specRequired(policy, size, requested).required;
            expect(specGateHolds(def, size, requested), `${kind} ${size} ${requested ?? "-"}`).toBe(
              today,
            );
          }
        }
      }
    });
  }
});

// The operation the Workflow (work-item.ts) opens each kind of gate with.
const ENGINE_GATE_OP: Record<string, string> = {
  spec: "spec.accept",
  step: "workflow.gate",
  merge: "pr.merge",
};
const NO_FLOOR = { ok: true as const, floor: {} };

function realGate(
  op: string,
  policy: { autonomyPolicy: AutonomyPolicyName; overrides: DecisionRules },
) {
  const operation = getOperation(op);
  if (!operation) throw new Error(`no operation ${op}`);
  // invoke(): `riskOf` (a merge touching nothing under .factory/), then the gate, then alwaysReview.
  const risk: RiskClass = op === "pr.merge" ? "merge" : operation.risk;
  const d = decide({ actor: "agent", risk, policy, floor: NO_FLOOR }).decision;
  return operation.alwaysReview && d === "allow" ? "review" : d;
}

describe("every gate decides as today's operation does, under every autonomy policy", () => {
  const OVERRIDES: Record<string, DecisionRules> = {
    "no overrides": {},
    "agents may plan": { agent: { plan: "allow" } },
    "agents may merge": { agent: { merge: "allow" } },
  };
  for (const [what, extra] of Object.entries(CONFIGS)) {
    for (const autonomyPolicy of AUTONOMY_POLICIES) {
      for (const [label, overrides] of Object.entries(OVERRIDES)) {
        it(`${what}, ${autonomyPolicy}, ${label}`, () => {
          const policy = policyOf({ ...extra, autonomyPolicy });
          for (const kind of KINDS) {
            const def = compileItemWorkflow(policy, policy.workflow, kind);
            let gates = 0;
            for (const inst of def.stages) {
              const type = stageType(inst.type);
              if (!type) throw new Error(`no stage type ${inst.type}`);
              const gate = type.gate(type.settings.parse(inst.settings));
              if (!gate) continue;
              gates++;
              const op = ENGINE_GATE_OP[gate.kind];
              expect(gate.operation, `${inst.id}'s operation`).toBe(op);
              const fromDef = decide({
                actor: "agent",
                risk: gate.risk,
                policy: { autonomyPolicy, overrides },
                floor: NO_FLOOR,
              }).decision;
              const stepAlways = gate.kind === "step";
              const fromDefEff = stepAlways && fromDef === "allow" ? "review" : fromDef;
              expect(fromDefEff, `${kind} ${inst.id}`).toBe(
                realGate(String(op), { autonomyPolicy, overrides }),
              );
              if (gate.kind === "merge") expect(ALWAYS_REVIEW).toContain(gate.risk);
            }
            expect(gates).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});

describe("phases: what shapes before release today", () => {
  it("a change shapes triage and spec, as STAGE_PHASE says; an incident and an attached PR shape nothing", () => {
    const policy = policyOf({ agents: AGENTS });
    for (const kind of KINDS) {
      const def = compileItemWorkflow(policy, null, kind);
      for (const { stage, phase } of engineStages(def, "large")) {
        if (phase === null) continue;
        // Incidents are opened queued (incident.open) and attached PRs on attach: released at once.
        expect(phase, `${kind} ${stage}`).toBe(kind === "change" ? STAGE_PHASE[stage] : "delivery");
      }
    }
  });
});

describe("compiling refuses slot steps that would share a stage id", () => {
  it("a step named after a Software stage and one already named step-<id>", () => {
    const policy = policyOf({
      agents: AGENTS,
      workflows: [
        {
          name: "Clash",
          slots: {
            afterSpec: [{ id: "build", kind: "gate", name: "Before build" }],
            afterVerify: [{ id: "step-build", kind: "gate", name: "Again" }],
          },
          core: {},
        },
      ],
      workflow: "Clash",
    });
    expect(() => compileProjectWorkflow(policy, "Clash")).toThrow(CompileError);
    expect(() => compileProjectWorkflow(policy, "Clash")).toThrow(/"build" and "step-build"/);
  });

  it("a step named after a Software stage alone plans with its own id", () => {
    const policy = policyOf({
      agents: AGENTS,
      workflows: [
        {
          name: "Named",
          slots: { afterSpec: [{ id: "build", kind: "gate", name: "Before build" }] },
          core: {},
        },
      ],
      workflow: "Named",
    });
    const def = compileProjectWorkflow(policy, "Named");
    expect(validateWorkflow(def, { agents: policy.agents }).valid).toBe(true);
    const today = planWorkflow(policy, "Named", "small", "[]");
    expect(planFromDefinition(def, policy.agents, "small", [], "Named")).toEqual(today);
  });
});
