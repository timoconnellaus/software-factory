// Spec 52, build plan PR (a): today's path expressed as stage lists changes nothing. Each part of
// the comparison is against the code that runs today:
// - the slot plan: `planWorkflow()` (the Workflow's own), for a table of configs, sizes and domains;
// - the spec gate: `specRequired()` (what `workItem.triage` records) for every threshold, size and
//   foreman request, and an attached PR's skip (the triage handler's `kind === "attached"` branch);
// - every gate under every autonomy policy: the operation the Workflow opens it with, through that
//   operation's own `riskOf` and `operationGate()` (the function `invoke()` calls), against the
//   stage type's gate spec through `stageGateDecision()` (its risk and `alwaysReview`, nothing else);
// - engine runs, against the compiled definition (`definition.ts`): the stages a run passes and
//   skips, the phases (what ran before release), send-back targets and slot steps, for a small
//   change and its send-backs (`workflow.test.ts`), an incident's fix (`workflow.test.ts`), a
//   shaped medium item with a spec (`shaping.test.ts`), slot steps (`workflows.test.ts`) and an
//   attached PR (`attach-flow.test.ts`).
import {
  ALWAYS_REVIEW,
  AUTONOMY_POLICIES,
  type AutonomyPolicyName,
  type DecisionRules,
  getOperation,
  operationGate,
  type ProjectPolicy,
  parseProjectPolicy,
  type RiskClass,
  specRequired,
} from "@software-factory/core";
import {
  CompileError,
  compileItemWorkflow,
  compileProjectWorkflow,
  planFromDefinition,
  SIZES as STAGE_SIZES,
  STAGE_TYPES,
  specGateHolds,
  stageGateDecision,
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

// The operation the Workflow (work-item.ts) opens each kind of gate with, and the input it passes
// (an ordinary merge: the diff touches nothing under `.factory/`).
const WI = `wi_${"0".repeat(32)}`;
const ENGINE_GATE: Record<string, { op: string; input: Record<string, unknown> }> = {
  spec: { op: "spec.accept", input: { workItemId: WI, specId: "spec_1" } },
  step: {
    op: "workflow.gate",
    input: { workItemId: WI, workflow: "w", stepId: "s", name: "S" },
  },
  merge: {
    op: "pr.merge",
    input: { workItemId: WI, headSha: "a".repeat(40), touchesFactoryConfig: false },
  },
};
const NO_FLOOR = { ok: true as const, floor: {} };

/**
 * The gate today's operation meets, exactly as `invoke()` computes it: the registry operation's own
 * `riskOf` on the Workflow's input, then `operationGate()` (the policy, the pinned version and
 * `alwaysReview`), the function invoke calls. Nothing here restates either.
 */
async function realGate(
  kind: string,
  policy: { autonomyPolicy: AutonomyPolicyName; overrides: DecisionRules },
) {
  const engine = ENGINE_GATE[kind];
  if (!engine) throw new Error(`no engine gate for ${kind}`);
  const operation = getOperation(engine.op);
  if (!operation) throw new Error(`no operation ${engine.op}`);
  const input = operation.input.parse(engine.input);
  // `riskOf` here reads only the input (pr.merge); the scope and db it may read are not consulted.
  const at = { scope: null, floor: NO_FLOOR, db: null } as unknown as Parameters<
    NonNullable<typeof operation.riskOf>
  >[1];
  const risk: RiskClass = operation.riskOf ? await operation.riskOf(input, at) : operation.risk;
  return operationGate({ op: operation, actor: "agent", risk, policy, floor: NO_FLOOR }).decision;
}

describe("every gate decides as today's operation does, under every autonomy policy", () => {
  const OVERRIDES: Record<string, DecisionRules> = {
    "no overrides": {},
    "agents may plan": { agent: { plan: "allow" } },
    "agents may merge": { agent: { merge: "allow" } },
    "agents may do anything": { agent: { "*": "allow" } },
  };
  for (const [what, extra] of Object.entries(CONFIGS)) {
    for (const autonomyPolicy of AUTONOMY_POLICIES) {
      for (const [label, overrides] of Object.entries(OVERRIDES)) {
        it(`${what}, ${autonomyPolicy}, ${label}`, async () => {
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
              expect(gate.operation, `${inst.id}'s operation`).toBe(ENGINE_GATE[gate.kind]?.op);
              // The registry's gate spec alone (its risk and `alwaysReview`), judged by the gate.
              const fromDef = stageGateDecision(gate, {
                actor: "agent",
                policy: { autonomyPolicy, overrides },
                floor: NO_FLOOR,
              }).decision;
              expect(fromDef, `${kind} ${inst.id}`).toBe(
                await realGate(gate.kind, { autonomyPolicy, overrides }),
              );
            }
            expect(gates).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});

const SAMPLE_SETTINGS: Record<string, object[]> = {
  decision: [{ when: { sizeAtLeast: "large" } }, { decider: { person: "octocat" } }],
};

describe("each gate spec's alwaysReview is its operation's", () => {
  it("a decision step and a merge always go to a person; the spec gate follows the policy", () => {
    for (const type of STAGE_TYPES) {
      const samples = [{}, ...(SAMPLE_SETTINGS[type.id] ?? [])];
      for (const settings of samples.map((x) => type.settings.parse(x))) {
        const gate = type.gate(settings);
        if (!gate) continue;
        const op = getOperation(gate.operation);
        expect(op, gate.operation).toBeDefined();
        expect(gate.alwaysReview, `${type.id}: ${gate.operation}`).toBe(
          op?.alwaysReview === true || ALWAYS_REVIEW.includes(gate.risk),
        );
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
