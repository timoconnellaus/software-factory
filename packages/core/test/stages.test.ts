// Spec 52, build plan PR (a): stage types as a registry, the floors, and today's path as the
// built-in Software workflow. Nothing at run time reads these yet.
import { describe, expect, it } from "vitest";
import { type AgentConfig, ALWAYS_REVIEW, parseProjectPolicy } from "../src/index.ts";
import {
  ATTACHED_PR,
  BUILT_IN_WORKFLOWS,
  compileProjectWorkflow,
  INCIDENT,
  planFromDefinition,
  SOFTWARE,
  STAGE_TYPES,
  stageGateDecision,
  stageType,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowRule,
} from "../src/stages/index.ts";

const AGENTS: AgentConfig[] = [
  { name: "Builder", role: "implement", tier: "standard", instructions: "", requires: [] },
  { name: "Security", role: "review", tier: "light", instructions: "", requires: [] },
];

const ok = (def: unknown, extra: Partial<Parameters<typeof validateWorkflow>[1]> = {}) =>
  validateWorkflow(def, { agents: AGENTS, ...extra });

function rules(def: unknown, extra: Partial<Parameters<typeof validateWorkflow>[1]> = {}) {
  const v = ok(def, extra);
  return v.valid ? [] : v.errors.map((e) => `${e.rule}:${e.stageId ?? "-"}`);
}

function nth<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`no item ${i}`);
  return value;
}

/** Software with its stages changed by `edit`. */
function software(edit: (stages: WorkflowDefinition["stages"]) => WorkflowDefinition["stages"]) {
  return { ...SOFTWARE, stages: edit(SOFTWARE.stages.map((s) => ({ ...s }))) };
}

describe("the registry's rules, for every stage type", () => {
  for (const type of STAGE_TYPES) {
    describe(type.id, () => {
      const defaults = type.settings.parse({});

      it("parses empty settings to its defaults, and an unchanged setting has no impact", () => {
        expect(type.impact(defaults, defaults, "s")).toEqual([]);
      });

      it("exposes no prompt or model id as a setting (F10)", () => {
        const keys = JSON.stringify(defaults);
        expect(keys).not.toMatch(/"(prompt|model|modelId)"/i);
      });

      it("is safe to place in shaping only if it holds no build slot, acts on nothing and has a person (F2–F4)", () => {
        if (!type.phases.includes("shaping")) return;
        expect(type.requires(defaults).pool).not.toBe("heavy");
        expect(type.reversibility).toBe("internal");
        expect(type.needsPerson || type.shapingWithoutPerson === true).toBe(true);
      });

      it("pairs an irreversible action with a required person's gate on the same artifact (F6)", () => {
        if (type.reversibility !== "irreversible") {
          expect(type.action).toBeUndefined();
          return;
        }
        const action = type.action?.(defaults);
        expect(action && ALWAYS_REVIEW.includes(action.risk)).toBe(true);
        const gate = type.gate(defaults);
        expect(gate?.mode).toBe("required");
        expect(gate?.on).toBe(action?.on);
      });

      it("never lets a setting remove a required gate", () => {
        const gate = type.gate(defaults);
        if (gate?.mode !== "required") return;
        // Every boolean setting flipped still leaves the gate required.
        for (const [key, value] of Object.entries(defaults)) {
          if (typeof value !== "boolean") continue;
          const flipped = type.settings.parse({ ...defaults, [key]: !value });
          expect(type.gate(flipped)?.mode).toBe("required");
        }
      });
    });
  }

  it("only triage may shape without a person (Q1)", () => {
    expect(STAGE_TYPES.filter((t) => t.shapingWithoutPerson).map((t) => t.id)).toEqual(["triage"]);
  });
});

describe("the built-in workflows", () => {
  it("Software, Incident and Attached PR are valid", () => {
    expect(rules(SOFTWARE)).toEqual([]);
    expect(rules(INCIDENT)).toEqual([]);
    expect(rules(ATTACHED_PR, { brings: ["git-head"] })).toEqual([]);
    expect(BUILT_IN_WORKFLOWS.attached).toBe(ATTACHED_PR);
  });

  it("Software's stage ids are today's stages, so the board reads the same", () => {
    expect(SOFTWARE.stages.map((s) => s.id)).toEqual([
      "triage",
      "spec",
      "build",
      "verify",
      "merge",
    ]);
    expect(SOFTWARE.stages.map((s) => s.phase)).toEqual([
      "shaping",
      "shaping",
      "delivery",
      "delivery",
      "delivery",
    ]);
  });

  it("validation fills each stage's settings with the type's defaults", () => {
    const v = ok(SOFTWARE);
    if (!v.valid) throw new Error("invalid");
    expect(v.definition.stages.find((s) => s.id === "spec")?.settings).toMatchObject({
      requiredFrom: "medium",
      decider: "approvers",
    });
  });
});

describe("validateWorkflow refuses each broken rule, with the stage", () => {
  const cases: [string, unknown, WorkflowRule, string | null, object?][] = [
    [
      "an unknown stage type",
      software((s) => [...s, { ...nth(s, 0), id: "x", type: "nope" }]),
      "S1",
      "x",
    ],
    [
      "a type version no longer run",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, typeVersion: 9 } : x))),
      "S1",
      "build",
    ],
    [
      "settings the type refuses",
      software((s) =>
        s.map((x) => (x.id === "build" ? { ...x, settings: { retryLimit: 99 } } : x)),
      ),
      "S1",
      "build",
    ],
    [
      "a duplicate stage id",
      software((s) => [...s.slice(0, 3), { ...nth(s, 2) }, ...s.slice(3)]),
      "S2",
      "build",
    ],
    [
      "a fixed state's id",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, id: "done" } : x))),
      "S2",
      "done",
    ],
    [
      "a bad stage id",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, id: "Build!" } : x))),
      "S2",
      "Build!",
    ],
    [
      "an unknown agent",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, agent: "Ghost" } : x))),
      "S3",
      "build",
    ],
    [
      "an agent with the wrong role",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, agent: "Security" } : x))),
      "S3",
      "build",
    ],
    [
      "an agent check with no agent",
      software((s) => [
        ...s.slice(0, 3),
        {
          id: "look",
          type: "agent-check",
          typeVersion: 1,
          name: "Look",
          phase: "delivery",
          settings: {},
        },
        ...s.slice(3),
      ]),
      "S3",
      "look",
    ],
    [
      "an agent check that builds",
      software((s) => [
        ...s.slice(0, 3),
        {
          id: "look",
          type: "agent-check",
          typeVersion: 1,
          name: "Look",
          phase: "delivery",
          settings: {},
          agent: "Builder",
        },
        ...s.slice(3),
      ]),
      "S3",
      "look",
    ],
    [
      "a type in a phase it can't take",
      software((s) => s.map((x) => (x.id === "build" ? { ...x, phase: "shaping" } : x))),
      "F1",
      "build",
    ],
    [
      "shaping after delivery",
      software((s) => [
        ...s,
        {
          id: "late",
          type: "decision",
          typeVersion: 1,
          name: "Late",
          phase: "shaping",
          settings: {},
        },
      ]),
      "F1",
      "late",
    ],
    ["no delivery stage", software((s) => s.slice(0, 2)), "F1", null],
    [
      "a stage that needs what nothing made",
      software((s) => s.filter((x) => x.id !== "build")),
      "F5",
      "verify",
    ],
    [
      "a merge with no required decision before it",
      software((s) =>
        s.map((x) => (x.id === "merge" ? { ...x, when: { sizeAtLeast: "large" } } : x)),
      ),
      "F7",
      "merge",
    ],
    [
      "a merge whose checks ran before the last build",
      software((s) => [
        nth(s, 0),
        nth(s, 1),
        nth(s, 2),
        nth(s, 3),
        { ...nth(s, 2), id: "rebuild" },
        nth(s, 4),
      ]),
      "F8",
      "merge",
    ],
    [
      "a merge whose only Checks stage can be skipped by `when` (F8 would otherwise be satisfied)",
      software((s) =>
        s.map((x) => (x.id === "verify" ? { ...x, when: { sizeAtLeast: "medium" } } : x)),
      ),
      "F7",
      "verify",
    ],
    [
      "a stage needing a repository the project lacks",
      SOFTWARE,
      "F9",
      "build",
      { hasRepository: false },
    ],
  ];
  for (const [what, def, rule, stageId, extra] of cases) {
    it(`${rule}: ${what}`, () => {
      expect(rules(def, extra)).toContain(`${rule}:${stageId ?? "-"}`);
    });
  }

  it("F2–F4: a heavy, outside-acting or person-less stage can't be shaping", () => {
    const def = software((s) => [
      ...s.slice(0, 2),
      {
        id: "look",
        type: "agent-check",
        typeVersion: 1,
        name: "Look",
        phase: "shaping",
        settings: {},
        agent: "Security",
      },
      ...s.slice(2),
    ]);
    // agent-check is delivery-only, so F1 catches it first; the floors still hold on their own.
    expect(rules(def)).toContain("F1:look");
    const type = stageType("agent-check");
    expect(type?.requires(type.settings.parse({})).pool).toBe("heavy");
  });

  it("F7: a conditional decision may be skipped by its typed condition, never by `when`", () => {
    const gateWith = (stage: object) =>
      software((s) => [
        ...s.slice(0, 4),
        {
          id: "sign-off",
          type: "decision",
          typeVersion: 1,
          name: "Sign-off",
          phase: "delivery",
          settings: {},
          ...stage,
        } as WorkflowDefinition["stages"][number],
        nth(s, 4),
      ]);
    expect(rules(gateWith({ settings: { when: { sizeAtLeast: "large" } } }))).toEqual([]);
    expect(rules(gateWith({ settings: {}, when: { sizeAtLeast: "large" } }))).toContain(
      "F7:sign-off",
    );
  });

  it("refuses more than 20 stages", () => {
    const many = {
      ...SOFTWARE,
      stages: Array.from({ length: 21 }, (_, i) => ({ ...nth(SOFTWARE.stages, 2), id: `b${i}` })),
    };
    expect(rules(many)).toContain("S2:-");
  });
});

describe("each type classifies its own settings changes", () => {
  const impact = (id: string, before: object, after: object) => {
    const t = stageType(id);
    if (!t) throw new Error(id);
    return t.impact(t.settings.parse(before), t.settings.parse(after), "s").map((c) => c.class);
  };
  it("a wider spec threshold loosens, a narrower one tightens", () => {
    expect(
      impact("interview-planning", { requiredFrom: "medium" }, { requiredFrom: "large" }),
    ).toEqual(["loosens"]);
    expect(
      impact("interview-planning", { requiredFrom: "medium" }, { requiredFrom: "small" }),
    ).toEqual(["tightens"]);
  });
  it("broadening who decides loosens; narrowing tightens", () => {
    expect(impact("decision", { decider: { person: "octocat" } }, {})).toEqual(["loosens"]);
    expect(impact("decision", {}, { decider: { person: "octocat" } })).toEqual(["tightens"]);
  });
  it("a gate's condition narrowed loosens", () => {
    expect(impact("decision", {}, { when: { sizeAtLeast: "large" } })).toEqual(["loosens"]);
  });
  it("dropping the reviewer, a required check or required evidence loosens", () => {
    expect(impact("checks", {}, { reviewer: false })).toEqual(["loosens"]);
    expect(impact("checks", {}, { requiredChecks: [] })).toEqual(["loosens"]);
    expect(impact("checks", {}, { requiredEvidence: ["ci"] })).toEqual(["loosens"]);
    expect(
      impact("checks", {}, { requiredEvidence: ["ci", "criteria", "reviewer", "tests-intact"] }),
    ).toEqual(["tightens"]);
  });
  it("merging around the queue loosens; retries are neutral; instructions loosen", () => {
    expect(impact("publish", {}, { via: "direct" })).toEqual(["loosens"]);
    expect(impact("build", {}, { retryLimit: 4 })).toEqual(["neutral"]);
    expect(impact("agent-check", {}, { instructions: "Look at auth." })).toEqual(["loosens"]);
  });
});

describe("today's per-project workflows as stage lists", () => {
  const policy = (extra: object) => {
    const parsed = parseProjectPolicy(
      JSON.stringify({ version: 1, autonomyPolicy: "balanced", ...extra }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.policy;
  };
  const withSlots = policy({
    agents: AGENTS,
    spec: { requiredFrom: "large" },
    retryLimit: 3,
    workflows: [
      {
        name: "Ship a feature",
        slots: {
          afterSpec: [{ id: "design", kind: "gate", name: "Design", approver: "octocat" }],
          beforeVerify: [
            {
              id: "security",
              kind: "work",
              name: "Security review",
              agent: "Security",
              when: { domain: "auth" },
            },
          ],
          afterVerify: [
            { id: "build", kind: "gate", name: "Big sign-off", when: { sizeAtLeast: "large" } },
          ],
        },
        core: { build: "Builder" },
      },
    ],
    workflow: "Ship a feature",
  });

  it("compiles to a valid definition with the slot steps in place", () => {
    const def = compileProjectWorkflow(withSlots, "Ship a feature");
    expect(rules(def)).toEqual([]);
    expect(def.stages.map((s) => `${s.id}:${s.type}`)).toEqual([
      "triage:triage",
      "spec:interview-planning",
      "design:decision",
      "build:build",
      "security:agent-check",
      "verify:checks",
      "step-build:decision",
      "merge:publish",
    ]);
    expect(def.stages.find((s) => s.id === "spec")?.settings).toMatchObject({
      requiredFrom: "large",
    });
    expect(def.stages.find((s) => s.id === "build")).toMatchObject({
      agent: "Builder",
      settings: { retryLimit: 3 },
    });
  });

  it("a project with no workflow compiles to Software", () => {
    const def = compileProjectWorkflow(policy({}), null);
    expect(def.stages.map((s) => s.id)).toEqual(SOFTWARE.stages.map((s) => s.id));
    expect(rules(def)).toEqual([]);
  });

  it("plans the slots, skips and build agent from the definition", () => {
    const def = compileProjectWorkflow(withSlots, "Ship a feature");
    const plan = planFromDefinition(def, withSlots.agents, "medium", [], "Ship a feature");
    expect(plan.build?.name).toBe("Builder");
    expect(plan.slots.afterSpec).toEqual([
      { id: "design", kind: "gate", name: "Design", instructions: "", approver: "octocat" },
    ]);
    expect(plan.slots.beforeVerify[0]).toMatchObject({
      id: "security",
      kind: "work",
      agent: { name: "Security" },
      skip: "only when the work touches auth",
    });
    expect(plan.slots.afterVerify[0]?.skip).toBe("only for large work and up (this is medium)");
  });
});

describe("a gate spec says whether a person always decides it (spec 52, re-review)", () => {
  const NO_FLOOR = { ok: true as const, floor: {} };
  const settingsOf = (id: string, raw: object = {}) => {
    const t = stageType(id);
    if (!t) throw new Error(id);
    return t.gate(t.settings.parse(raw));
  };
  it("a decision step stays with a person under 'agents may plan'; the spec gate follows the policy", () => {
    const policy = {
      autonomyPolicy: "autonomous" as const,
      overrides: { agent: { plan: "allow" as const } },
    };
    const step = settingsOf("decision");
    const spec = settingsOf("interview-planning");
    if (!step || !spec) throw new Error("no gate");
    expect(step.alwaysReview).toBe(true);
    expect(stageGateDecision(step, { actor: "agent", policy, floor: NO_FLOOR }).decision).toBe(
      "review",
    );
    expect(spec.alwaysReview).toBe(false);
    expect(stageGateDecision(spec, { actor: "agent", policy, floor: NO_FLOOR }).decision).toBe(
      "allow",
    );
  });
});
