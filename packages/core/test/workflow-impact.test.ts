// The workflow classifier is the security core of org workflows (spec 52 PR (b), ADR 0516): a save
// it calls neutral or tightening applies with no approver. These are the cases a review found
// coming out neutral, an allow-list property test over random edits, and the surfaces and actors
// that may never save, approve or roll back an org workflow.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import type { Actor, InvokeResult } from "../src/index.ts";
import { invoke, parseProjectPolicy } from "../src/index.ts";
import { riskOfSave } from "../src/operations/workflows.ts";
import {
  ATTACHED_PR,
  type Condition,
  compileProjectWorkflow,
  type Decider,
  deciderChange,
  INCIDENT,
  SIZE_RANK,
  type Size,
  SOFTWARE,
  STAGE_TYPES,
  type StageInstance,
  stageType,
  type WorkflowDefinition,
  workflowImpact,
} from "../src/stages/index.ts";
import { call, deps, ok, RUNNER_ACTOR, refusal, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const withStages = (
  def: WorkflowDefinition,
  edit: (s: StageInstance[]) => StageInstance[],
): WorkflowDefinition => ({ ...def, stages: edit(def.stages.map((s) => ({ ...s }))) });

const SECURITY: StageInstance = {
  id: "security",
  type: "agent-check",
  typeVersion: 1,
  name: "Security review",
  phase: "delivery",
  settings: {},
};

describe("the cases a review found classified neutral", () => {
  it("hiding review packet sections: no `sections` (every section) to a list loosens", () => {
    const only = withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "verify" ? { ...x, settings: { sections: ["summary"] } } : x)),
    );
    expect(workflowImpact(SOFTWARE, only).class).toBe("loosens");
    // Back to every section tightens; dropping one from a list loosens; reordering is neutral.
    expect(workflowImpact(only, SOFTWARE).class).toBe("tightens");
    const two = withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "verify" ? { ...x, settings: { sections: ["summary", "risk"] } } : x)),
    );
    const swapped = withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "verify" ? { ...x, settings: { sections: ["risk", "summary"] } } : x)),
    );
    expect(workflowImpact(two, only).class).toBe("loosens");
    expect(workflowImpact(two, swapped).class).toBe("neutral");
  });

  it("moving a check before the stage it checks loosens", () => {
    const after = withStages(SOFTWARE, (s) => [...s.slice(0, 3), SECURITY, ...s.slice(3)]);
    const before = withStages(after, (s) => [
      ...s.filter((x) => x.id !== "security").slice(0, 2),
      SECURITY,
      ...s.filter((x) => x.id !== "security").slice(2),
    ]);
    // The security check after build → before build: it no longer sees the build.
    expect(after.stages.map((s) => s.id)).toEqual([
      "triage",
      "spec",
      "build",
      "security",
      "verify",
      "merge",
    ]);
    expect(workflowImpact(after, before).class).toBe("loosens");
    // Work moved after a gate that used to follow it loosens too.
    const buildLate = withStages(
      SOFTWARE,
      (s) => [s[0], s[1], s[3], s[2], s[4]] as StageInstance[],
    );
    expect(workflowImpact(SOFTWARE, buildLate).class).toBe("loosens");
  });

  it("removing Triage loosens: items arrive unsized and miss the spec gate", () => {
    const noTriage = withStages(SOFTWARE, (s) => s.filter((x) => x.id !== "triage"));
    expect(workflowImpact(SOFTWARE, noTriage).class).toBe("loosens");
    // So does a condition on it.
    const sometimes = withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "triage" ? { ...x, when: { domain: "auth" } } : x)),
    );
    expect(workflowImpact(SOFTWARE, sometimes).class).toBe("loosens");
  });

  it("a typeVersion bump the type can't migrate loosens, whatever the settings", () => {
    const bumped = withStages(SOFTWARE, (s) =>
      s.map((x) =>
        x.id === "verify" ? { ...x, typeVersion: 2, settings: { reviewer: false } } : x,
      ),
    );
    const impact = workflowImpact(SOFTWARE, bumped);
    expect(impact.class).toBe("loosens");
    expect(impact.changes.some((c) => c.path === "stages.verify.typeVersion")).toBe(true);
  });

  it("a type's migration lets a version bump be compared setting by setting", () => {
    const checks = stageType("checks");
    if (!checks) throw new Error("no checks type");
    const saved = { version: checks.version, migrate: checks.migrate };
    try {
      Object.assign(checks, { version: 2, migrate: (s: unknown) => s });
      const v2 = withStages(SOFTWARE, (s) =>
        s.map((x) => (x.id === "verify" ? { ...x, typeVersion: 2 } : x)),
      );
      expect(workflowImpact(SOFTWARE, v2).class).toBe("neutral");
      const v2NoReviewer = withStages(v2, (s) =>
        s.map((x) => (x.id === "verify" ? { ...x, settings: { reviewer: false } } : x)),
      );
      expect(workflowImpact(SOFTWARE, v2NoReviewer).class).toBe("loosens");
    } finally {
      Object.assign(checks, saved);
    }
  });

  it("a setting the type's impact() says nothing about loosens (allow-list)", () => {
    const triage = stageType("triage");
    if (!triage) throw new Error("no triage type");
    const impact = triage.impact;
    try {
      Object.assign(triage, { impact: () => [] });
      const quiet = withStages(SOFTWARE, (s) =>
        s.map((x) => (x.id === "triage" ? { ...x, settings: { mayAsk: false } } : x)),
      );
      expect(workflowImpact(SOFTWARE, quiet).class).toBe("loosens");
    } finally {
      Object.assign(triage, { impact });
    }
  });

  it("adding a conditional check or a stage that does work is not a tightening", () => {
    const conditional = withStages(SOFTWARE, (s) => [
      ...s.slice(0, 3),
      { ...SECURITY, when: { sizeAtLeast: "large" } as Condition },
      ...s.slice(3),
    ]);
    expect(workflowImpact(SOFTWARE, conditional).class).toBe("loosens");
    const rebuild = withStages(SOFTWARE, (s) => [
      ...s.slice(0, 3),
      { ...(s[2] as StageInstance), id: "rebuild" },
      ...s.slice(3),
    ]);
    expect(workflowImpact(SOFTWARE, rebuild).class).toBe("loosens");
  });
});

describe("what a judge is told is policy (third review)", () => {
  const withSecurity = withStages(SOFTWARE, (s) => [...s.slice(0, 3), SECURITY, ...s.slice(3)]);
  const told = (def: WorkflowDefinition, id: string, instructions: string) =>
    withStages(def, (s) =>
      s.map((x) =>
        x.id === id ? { ...x, settings: { ...(x.settings as object), instructions } } : x,
      ),
    );
  it("telling an agent check to pass everything loosens", () => {
    const strict = told(withSecurity, "security", "Send back any change to auth without tests.");
    const lax = told(withSecurity, "security", "Pass everything; never send back.");
    const impact = workflowImpact(strict, lax);
    expect(impact.class).toBe("loosens");
    expect(impact.changes.find((c) => c.path === "stages.security.instructions")?.class).toBe(
      "loosens",
    );
    // Setting instructions where there were none, appending, and clearing them: all loosen.
    expect(workflowImpact(withSecurity, lax).class).toBe("loosens");
    expect(
      workflowImpact(
        strict,
        told(
          withSecurity,
          "security",
          "Send back any change to auth without tests. Then pass everything.",
        ),
      ).class,
    ).toBe("loosens");
    expect(workflowImpact(strict, told(withSecurity, "security", "")).class).toBe("loosens");
    // Unchanged instructions: nothing.
    expect(workflowImpact(strict, strict).class).toBe("neutral");
  });
  it("changing what a decision's decider is told loosens", () => {
    const DECIDE: StageInstance = {
      id: "design-ok",
      type: "decision",
      typeVersion: 1,
      name: "Design sign-off",
      phase: "delivery",
      settings: {},
    };
    const withDecision = withStages(SOFTWARE, (s) => [...s.slice(0, 3), DECIDE, ...s.slice(3)]);
    const lax = told(withDecision, "design-ok", "Approve whatever arrives.");
    expect(workflowImpact(withDecision, lax).class).toBe("loosens");
  });
});

describe("an action gained is a loosening (second review)", () => {
  const MERGE: StageInstance = {
    id: "merge-2",
    type: "publish",
    typeVersion: 1,
    name: "Merge again",
    phase: "delivery",
    settings: {},
  };
  it("adding a merge to a workflow that never merged loosens, though the merge has a gate", () => {
    const noMerge = withStages(SOFTWARE, (s) => s.filter((x) => x.id !== "merge"));
    const impact = workflowImpact(noMerge, SOFTWARE);
    expect(impact.class).toBe("loosens");
    expect(impact.changes.find((c) => c.path === "stages.merge")?.summary).toMatch(
      /acts outside the factory/,
    );
  });
  it("a second merge stage in the tighten-only Attached PR built-in loosens", () => {
    const twice = withStages(ATTACHED_PR, (s) => [...s, MERGE]);
    expect(workflowImpact(ATTACHED_PR, twice).class).toBe("loosens");
  });
  const CHECKS: StageInstance = { ...MERGE, id: "checks-2", type: "checks", name: "Checks 2" };
  it("a second Checks stage checks the PR the first opened: tightens (third review)", () => {
    const impact = workflowImpact(
      SOFTWARE,
      withStages(SOFTWARE, (s) => [...s.slice(0, 4), CHECKS, ...s.slice(4)]),
    );
    expect(impact.class).toBe("tightens");
    expect(impact.changes.find((c) => c.path === "stages.checks-2")?.class).toBe("tightens");
    // At the end too, after the merge: it still opens nothing.
    expect(
      workflowImpact(
        SOFTWARE,
        withStages(SOFTWARE, (s) => [...s, CHECKS]),
      ).class,
    ).toBe("tightens");
  });
  it("a Checks stage that would open the only PR acts outside the factory: loosens", () => {
    // No earlier stage produces a pull request: this one opens it.
    const noChecks = withStages(SOFTWARE, (s) =>
      s.filter((x) => x.id !== "verify" && x.id !== "merge"),
    );
    const impact = workflowImpact(
      noChecks,
      withStages(noChecks, (s) => [...s, CHECKS]),
    );
    expect(impact.class).toBe("loosens");
    expect(impact.changes.find((c) => c.path === "stages.checks-2")?.summary).toMatch(
      /acts outside the factory/,
    );
    // Before the existing Checks stage it opens the PR itself: loosens (and moves nothing).
    const first = withStages(SOFTWARE, (s) => [...s.slice(0, 3), CHECKS, ...s.slice(3)]);
    expect(workflowImpact(SOFTWARE, first).class).toBe("loosens");
    // After a Checks stage that runs only for some items: for the rest it opens one: loosens.
    const sometimes = withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "verify" ? { ...x, when: { sizeAtLeast: "large" as const } } : x)),
    );
    const impact2 = workflowImpact(
      sometimes,
      withStages(sometimes, (s) => [...s, CHECKS]),
    );
    expect(impact2.changes.find((c) => c.path === "stages.checks-2")?.class).toBe("loosens");
  });
  it("an added merge loosens even after a merge that already exists", () => {
    expect(
      workflowImpact(
        SOFTWARE,
        withStages(SOFTWARE, (s) => [...s, MERGE]),
      ).class,
    ).toBe("loosens");
  });
  it("an added internal gate still tightens", () => {
    expect(
      workflowImpact(
        SOFTWARE,
        withStages(SOFTWARE, (s) => [...s, SECURITY]),
      ).class,
    ).toBe("tightens");
  });
});

describe("the save path", () => {
  async function version(w: W) {
    return (await ok<{ version: number }>("workflow.list", { orgId: w.orgId }, w.human)).version;
  }
  async function save(w: W, workflow: WorkflowDefinition) {
    return call<{ version: number }>(
      "workflow.save",
      { orgId: w.orgId, baseVersion: await version(w), workflow },
      w.human,
    );
  }
  const signOff: StageInstance = {
    id: "sign-off",
    type: "decision",
    typeVersion: 1,
    name: "Sign-off",
    phase: "delivery",
    settings: {},
  };

  it("archive, then re-add under the same id with the gate removed: the re-add waits for an admin", async () => {
    const w = await world();
    const made = await ok<{ workflowId: string }>(
      "workflow.createFromTemplate",
      { orgId: w.orgId, baseVersion: 0, templateId: SOFTWARE.id, name: "Ship it" },
      w.human,
    );
    const { workflow } = await ok<{ workflow: WorkflowDefinition }>(
      "workflow.get",
      { orgId: w.orgId, workflowId: made.workflowId },
      w.human,
    );
    const gated = withStages(workflow, (s) => [...s.slice(0, 4), signOff, ...s.slice(4)]);
    expect((await save(w, gated)).status).toBe("ok");
    const archived = await call(
      "workflow.archive",
      { orgId: w.orgId, baseVersion: await version(w), workflowId: made.workflowId },
      w.human,
    );
    expect(archived.status).toBe("ok");
    // Re-added without the sign-off: compared against the archived version, so it loosens.
    expect((await save(w, workflow)).status).toBe("pending");
    // Re-added as it was archived: neutral, applies.
    expect((await save(w, gated)).status).toBe("ok");
  });

  it("a brand-new workflow is compared against the Software floor", async () => {
    const w = await world();
    const later = withStages({ ...SOFTWARE, id: "wf_bare", name: "Bare" }, (s) =>
      s.map((x) => (x.id === "spec" ? { ...x, settings: { requiredFrom: "large" } } : x)),
    );
    expect((await save(w, later)).status).toBe("pending");
    const same = { ...SOFTWARE, id: "wf_same", name: "Same" };
    expect((await save(w, same)).status).toBe("ok");
  });

  it("if working out the risk throws, the save is self-modify", async () => {
    const w = await world();
    const risk = await riskOfSave(createDb(env.DB), w.orgId, 0, () => {
      throw new Error("boom");
    });
    expect(risk).toBe("self-modify");
  });
});

describe("who may save, approve and roll back org workflows", () => {
  const surfaces = ["cli", "mcp", "desktop", "mobile"] as const;
  type Way = { label: string; actor: (w: W) => Actor; surface: (typeof surfaces)[number] | "test" };
  const WAYS: Way[] = [
    { label: "an agent", actor: () => ({ type: "agent", id: "foreman" }), surface: "test" },
    { label: "a runner", actor: () => RUNNER_ACTOR("run_x"), surface: "test" },
    // A desktop device's and a phone's token, and any other surface a token reaches (the CLI, MCP).
    ...surfaces.map((surface) => ({
      label: `a person's ${surface} token`,
      actor: (w: W) => w.human,
      surface,
    })),
  ];

  async function as<O>(w: W, way: Way, op: string, input: unknown) {
    return invoke<O>(deps, op, input, {
      actor: way.actor(w),
      origin: {
        surface: way.surface,
        ...(way.surface === "desktop" || way.surface === "mobile" ? { deviceId: "dev_x" } : {}),
      },
    });
  }

  async function pendingLoosening(w: W): Promise<string> {
    const later = withStages({ ...SOFTWARE, id: "wf_loose", name: "Loose" }, (s) =>
      s.map((x) => (x.id === "spec" ? { ...x, settings: { requiredFrom: "large" } } : x)),
    );
    const r = (await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 0, workflow: later },
      w.human,
    )) as InvokeResult<unknown>;
    if (r.status !== "pending") throw new Error(`expected pending, got ${r.status}`);
    return r.pendingActionId;
  }

  for (const way of WAYS) {
    it(`${way.label} can't save, approve or roll back`, async () => {
      const w = await world();
      const saved = await refusal(
        as(w, way, "workflow.save", {
          orgId: w.orgId,
          baseVersion: 0,
          workflow: { ...SOFTWARE, id: "wf_x", name: "X" },
        }),
      );
      expect(saved.code).toBe("forbidden");
      const pendingActionId = await pendingLoosening(w);
      const approved = await refusal(
        as(w, way, "approval.decide", { pendingActionId, decision: "approved" }),
      );
      expect(approved.code).toBe("forbidden");
      const rolled = await refusal(
        as(w, way, "orgConfig.rollback", { orgId: w.orgId, baseVersion: 0, toVersion: 1 }),
      );
      expect(rolled.code).toBe("forbidden");
    });
  }
});

// ---- The allow-list property: random edits, and what a neutral or tightening one keeps ----

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES: Size[] = ["small", "medium", "large"];
const DOMAINS: string[][] = [[], ["auth"]];
const SECTION_POOL = ["summary", "risk", "tests", "diff", "criteria"];
const CHECK_POOL = ["build", "lint", "test", "e2e"];
const EVIDENCE_POOL = ["ci", "check", "criteria", "reviewer", "drift", "tests-intact"];

function holds(when: Condition | undefined, size: Size, domains: string[]): boolean {
  if (when?.sizeAtLeast && SIZE_RANK[size] < SIZE_RANK[when.sizeAtLeast]) return false;
  if (when?.domain && !domains.includes(when.domain)) return false;
  return true;
}

interface Seen {
  facts: Set<string>;
  deciders: Map<string, Decider>;
  /** What the definition does outside the factory: each outward stage's action and connectors. */
  actions: Set<string>;
}

/** Every gate, check, approver set, evidence item, section and order a definition gives an item. */
function seen(def: WorkflowDefinition, size: Size, domains: string[]): Seen {
  const facts = new Set<string>();
  const deciders = new Map<string, Decider>();
  const actions = new Set<string>();
  const running: { id: string; guard: boolean }[] = [];
  const produced = new Set<string>();
  for (const s of def.stages) {
    const type = stageType(s.type);
    if (!type) continue;
    const parsed = type.settings.safeParse(s.settings ?? {});
    // biome-ignore lint/suspicious/noExplicitAny: each type's settings, read by key below.
    const st: any = parsed.success ? parsed.data : type.settings.parse({});
    if (!holds(s.when, size, domains)) continue;
    const act = type.reversibility !== "internal" ? type.action?.(st) : undefined;
    // An outward stage with no action of its own whose artifacts already exist works on those (a
    // second Checks stage checks the PR the first opened): it does nothing new outside.
    const reuses = !act && type.produces.length > 0 && type.produces.every((k) => produced.has(k));
    for (const k of type.produces) produced.add(k);
    if (type.reversibility !== "internal" && !reuses) {
      actions.add(`${type.reversibility}:${s.id}:${act ? `${act.operation}:${act.risk}` : "-"}`);
      for (const c of type.requires(st).connectors) actions.add(`connector:${s.id}:${c}`);
    }
    let guard = false;
    const gate = type.gate(st);
    if (type.id === "triage") facts.add("sized");
    if (type.id === "checks") {
      guard = true;
      facts.add(`check:${s.id}`);
      if (st.reviewer) facts.add(`reviewer:${s.id}`);
      if (st.drift) facts.add(`drift:${s.id}`);
      for (const e of st.requiredEvidence) facts.add(`evidence:${s.id}:${e}`);
      for (const c of st.requiredChecks) facts.add(`requiredCheck:${s.id}:${c}`);
      if (!st.sections) facts.add(`sections:${s.id}:*`);
      else for (const x of st.sections) facts.add(`section:${s.id}:${x}`);
    }
    if (type.id === "agent-check") {
      guard = true;
      facts.add(`check:${s.id}`);
    }
    if (gate) {
      let open = true;
      if (type.id === "interview-planning")
        open = size === "large" || SIZE_RANK[size] >= SIZE_RANK[st.requiredFrom as Size];
      if (type.id === "decision") open = holds(st.when, size, domains);
      if (type.id === "interview-planning" && st.critic) facts.add(`critic:${s.id}`);
      if (type.id === "publish" && st.via === "mergeQueue") facts.add(`queue:${s.id}`);
      if (open) {
        guard = true;
        facts.add(`gate:${s.id}`);
        deciders.set(s.id, st.decider as Decider);
      }
    }
    running.push({ id: s.id, guard });
  }
  for (let i = 0; i < running.length; i++)
    for (let j = i + 1; j < running.length; j++) {
      const a = running[i] as { id: string; guard: boolean };
      const b = running[j] as { id: string; guard: boolean };
      if (a.guard || b.guard) facts.add(`order:${a.id}<${b.id}`);
    }
  return { facts, deciders, actions };
}

/** Every outward or irreversible action `after` takes that `before` didn't: an action gained. */
function gained(before: Seen, after: Seen): string[] {
  return [...after.actions].filter((a) => !before.actions.has(a)).map((a) => `gained:${a}`);
}

function lost(before: Seen, after: Seen): string[] {
  const out: string[] = [];
  for (const f of before.facts) {
    if (after.facts.has(f)) continue;
    const m = /^section:([^:]+):/.exec(f);
    if (m && after.facts.has(`sections:${m[1]}:*`)) continue;
    out.push(f);
  }
  for (const [id, d] of before.deciders) {
    const now = after.deciders.get(id);
    if (now && deciderChange(d, now) === "loosens") out.push(`decider:${id}`);
  }
  return out;
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

function randomWhen(r: () => number): Condition | undefined {
  const k = r();
  if (k < 0.5) return undefined;
  if (k < 0.8) return { sizeAtLeast: pick(r, SIZES) };
  return { domain: pick(r, ["auth", "billing"]) };
}

function mutateValue(r: () => number, key: string, value: unknown): unknown {
  if (key === "sections")
    return r() < 0.3
      ? undefined
      : SECTION_POOL.filter(() => r() < 0.5).concat(r() < 0.5 ? [] : ["summary"]);
  if (key === "decider") return r() < 0.5 ? "approvers" : { person: pick(r, ["ana", "bo"]) };
  if (key === "requiredFrom") return pick(r, SIZES);
  if (key === "via") return pick(r, ["mergeQueue", "direct"]);
  if (key === "when") return randomWhen(r);
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return Math.max(1, value + pick(r, [-2, -1, 1, 2]));
  if (typeof value === "string") return `${value} ${pick(r, ["x", "y"])}`;
  if (Array.isArray(value)) {
    const pool = key === "requiredEvidence" ? EVIDENCE_POOL : CHECK_POOL;
    const k = r();
    if (k < 0.33 && value.length)
      return value.filter((_, i) => i !== Math.floor(r() * value.length));
    if (k < 0.66) return [...new Set([...value, pick(r, pool)])];
    return [...value].reverse();
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const k = pick(r, Object.keys(o));
    return { ...o, [k]: mutateValue(r, k, o[k]) };
  }
  return value;
}

function randomEdit(r: () => number, def: WorkflowDefinition, n: number): WorkflowDefinition {
  const stages = def.stages.map((s) => ({ ...s }));
  const at = Math.floor(r() * stages.length);
  const s = stages[at];
  const k = Math.floor(r() * 8);
  if (k === 0 && s) stages.splice(at, 1);
  else if (k === 1) {
    const type = pick(r, STAGE_TYPES);
    const defaults = type.settings.parse({}) as Record<string, unknown>;
    const key = pick(r, Object.keys(defaults).concat(["-"]));
    const settings = key === "-" ? {} : { ...defaults, [key]: mutateValue(r, key, defaults[key]) };
    const when = randomWhen(r);
    stages.splice(Math.floor(r() * (stages.length + 1)), 0, {
      id: `added-${n}`,
      type: type.id,
      typeVersion: 1,
      name: `Added ${n}`,
      phase: "delivery",
      settings,
      ...(when ? { when } : {}),
    });
  } else if (k === 2 && s) {
    stages.splice(at, 1);
    stages.splice(Math.floor(r() * (stages.length + 1)), 0, s);
  } else if (k === 3 && s) {
    const type = stageType(s.type);
    if (type) {
      const parsed = type.settings.safeParse(s.settings ?? {});
      const current = (parsed.success ? parsed.data : (s.settings ?? {})) as Record<
        string,
        unknown
      >;
      const key = pick(r, Object.keys(current).concat(["sections", "when"]));
      if (key in current || type.id === "checks" || type.id === "decision")
        s.settings = { ...current, [key]: mutateValue(r, key, current[key]) };
    }
  } else if (k === 4 && s) {
    const when = randomWhen(r);
    if (when) s.when = when;
    else delete s.when;
  } else if (k === 5 && s) s.phase = s.phase === "shaping" ? "delivery" : "shaping";
  else if (k === 6 && s) s.typeVersion = s.typeVersion + 1;
  else if (s) {
    if (r() < 0.5) s.name = `${s.name}!`;
    else s.agent = pick(r, ["Builder", "Security"]);
  }
  return { ...def, stages };
}

describe("the classifier is an allow-list: what it calls neutral or tightening keeps everything", () => {
  const policy = parseProjectPolicy(
    JSON.stringify({
      version: 1,
      autonomyPolicy: "balanced",
      agents: [{ name: "Security", role: "review", tier: "light", instructions: "" }],
      workflows: [
        {
          name: "Gated",
          slots: {
            afterSpec: [{ id: "design", kind: "gate", name: "Design", approver: "ana" }],
            beforeVerify: [
              {
                id: "sec",
                kind: "work",
                name: "Security",
                agent: "Security",
                when: { domain: "auth" },
              },
            ],
            afterVerify: [
              { id: "sign-off", kind: "gate", name: "Sign-off", when: { sizeAtLeast: "large" } },
            ],
          },
          core: {},
        },
      ],
      workflow: "Gated",
    }),
  );
  if (!policy.ok) throw new Error(policy.error);
  const STARTS: WorkflowDefinition[] = [
    SOFTWARE,
    INCIDENT,
    ATTACHED_PR,
    compileProjectWorkflow(policy.policy, "Gated"),
    withStages(SOFTWARE, (s) =>
      s.map((x) => (x.id === "verify" ? { ...x, settings: { sections: ["summary", "risk"] } } : x)),
    ),
  ];

  it("over 3,000 random edits (1–3 changes each, from every start), across kinds and sizes", () => {
    const r = rng(52);
    let accepted = 0;
    for (let i = 0; i < 3_000; i++) {
      const before = pick(r, STARTS);
      let after = before;
      const edits = 1 + Math.floor(r() * 3);
      for (let e = 0; e < edits; e++) after = randomEdit(r, after, i * 10 + e);
      const impact = workflowImpact(before, after);
      if (impact.class === "loosens") continue;
      accepted++;
      for (const size of SIZES)
        for (const domains of DOMAINS) {
          const b = seen(before, size, domains);
          const a = seen(after, size, domains);
          const missing = [...lost(b, a), ...gained(b, a)];
          expect(
            missing,
            `edit ${i} (${impact.class}) at ${size} ${domains.join(",")}: ${JSON.stringify(after.stages)}`,
          ).toEqual([]);
        }
    }
    // The generator does produce accepted edits, so the property is exercised.
    expect(accepted).toBeGreaterThan(300);
  });
});
