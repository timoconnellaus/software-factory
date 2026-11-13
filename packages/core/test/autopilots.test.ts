// Autopilots in the org config (ADR 0514, spec 52 build step (g), first part): the `autopilot`
// actor never merges, deploys or changes config, whatever a policy or override says; the shape and
// its checks; how a change classifies; and the operations that change them through the org config.
import { describe, expect, it } from "vitest";
import {
  type AutopilotConfig,
  autopilotImpact,
  autopilotSchema,
  cronError,
} from "../src/autopilots/index.ts";
import { AUTONOMY_POLICIES, decide, RISK_CLASSES } from "../src/policy/gate.ts";
import { call, FOREMAN, ok, refusal, rows, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const AP = (over: Partial<Record<string, unknown>> = {}): AutopilotConfig =>
  autopilotSchema.parse({
    id: "ap_triage",
    name: "Overnight triage",
    trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "Australia/Sydney" },
    agent: "Triager",
    output: { kind: "labels" },
    ...over,
  });

describe("the autopilot actor (ADR 0514)", () => {
  it("is denied merge, deploy, check-merge and self-modify in every policy, even with an override", () => {
    for (const policy of AUTONOMY_POLICIES)
      for (const risk of RISK_CLASSES) {
        const d = decide({
          actor: "autopilot",
          risk,
          policy: {
            autonomyPolicy: policy,
            // A project tries to let it do everything.
            overrides: { autopilot: { "*": "allow" }, "*": { "*": "allow" } },
          },
          floor: { ok: true, floor: {} },
        });
        if (["merge", "deploy", "check-merge", "self-modify"].includes(risk))
          expect(d, `${policy} ${risk}`).toMatchObject({ decision: "deny" });
      }
  });

  it("reads and files work; plans, spends and goes outbound only if a policy says so", () => {
    for (const policy of AUTONOMY_POLICIES) {
      const at = (risk: (typeof RISK_CLASSES)[number]) =>
        decide({
          actor: "autopilot",
          risk,
          policy: { autonomyPolicy: policy, overrides: {} },
          floor: { ok: true, floor: {} },
        }).decision;
      expect(at("read")).toBe("allow");
      expect(at("write")).toBe("allow");
      for (const r of ["plan", "spend", "outbound"] as const) expect(at(r)).toBe("deny");
    }
  });
});

describe("the autopilot's shape", () => {
  it("runs at most hourly: one fixed minute", () => {
    expect(cronError("15 * * * *")).toBeNull();
    expect(cronError("0 2 * * 1-5")).toBeNull();
    expect(cronError("0 */6 1,15 * *")).toBeNull();
    for (const c of [
      "* * * * *",
      "*/5 * * * *",
      "0,30 * * * *",
      "0 25 * * *",
      "0 2 * *",
      "x 2 * * *",
    ])
      expect(cronError(c), c).not.toBeNull();
  });

  it("refuses hidden characters in its name, description and instructions, and instructions over 4 kB", () => {
    const bad = (over: Record<string, unknown>) =>
      autopilotSchema.safeParse({ ...AP(), ...over }).success;
    expect(bad({ name: "Triage\u202e" })).toBe(false);
    expect(bad({ description: "ok\u200bnot" })).toBe(false);
    expect(bad({ instructions: "do this\u2066" })).toBe(false);
    expect(bad({ instructions: "line one\nline two" })).toBe(true);
    // 4 kB in bytes: 1,500 three-byte characters is over, though under 4,000 characters.
    expect(bad({ instructions: "€".repeat(1_500) })).toBe(false);
  });

  it("refuses an unknown time zone and limits past their caps; fills defaults", () => {
    expect(
      autopilotSchema.safeParse({
        ...AP(),
        trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "Mars/Olympus" },
      }).success,
    ).toBe(false);
    expect(
      autopilotSchema.safeParse({ ...AP(), limits: { minutes: 90, maxOutputs: 5, runsPerDay: 4 } })
        .success,
    ).toBe(false);
    expect(AP()).toMatchObject({
      enabled: false,
      scope: { projects: "all" },
      limits: { minutes: 30, maxOutputs: 5, runsPerDay: 4 },
    });
  });
});

describe("how a change to an autopilot classifies: by reach (ADR 0514 §5, review of #197)", () => {
  const cls = (before: AutopilotConfig[], after: AutopilotConfig[]) =>
    autopilotImpact(before, after).map((c) => c.class);
  const loosens = (b: AutopilotConfig[], a: AutopilotConfig[]) => cls(b, a).includes("loosens");
  const ON = (over: Partial<Record<string, unknown>> = {}) => AP({ enabled: true, ...over });
  const queued = { kind: "backlog", project: "each", state: "queued" };

  it("a new one: off is practice; on loosens (judged against nothing); turning on loosens, off tightens", () => {
    expect(loosens([], [AP()])).toBe(false);
    expect(loosens([], [ON()])).toBe(true);
    expect(loosens([AP()], [ON()])).toBe(true);
    expect(cls([ON()], [AP()])).toContain("tightens");
    expect(loosens([ON()], [AP()])).toBe(false);
    expect(cls([ON()], [])).toEqual(["tightens"]);
  });

  it("every pair of trigger kinds, both ways", () => {
    const sched = (cron: string) => ({ kind: "schedule", cron, timezone: "UTC" });
    const event = (projects?: string[], ev = "workItem.captured") => ({
      kind: "event",
      event: ev,
      ...(projects ? { projects } : {}),
    });
    const scope = { projects: ["p1", "p2"] };
    const at = (trigger: unknown) => ON({ trigger, scope });
    // schedule <-> event: an event fires without bound, on projects' events.
    expect(loosens([at(sched("0 2 * * 1"))], [at(event(["p1"]))])).toBe(true);
    expect(loosens([at(event(["p1"]))], [at(sched("0 2 * * 1"))])).toBe(false);
    // event projects wider / narrower; another event kind.
    expect(loosens([at(event(["p1"]))], [at(event())])).toBe(true);
    expect(loosens([at(event())], [at(event(["p1"]))])).toBe(false);
    expect(loosens([at(event(["p1"]))], [at(event(["p1"], "workItem.done"))])).toBe(true);
    // a more frequent schedule loosens; a rarer one doesn't.
    expect(loosens([at(sched("0 2 * * 1"))], [at(sched("0 * * * *"))])).toBe(true);
    expect(loosens([at(sched("0 * * * *"))], [at(sched("0 2 * * 1"))])).toBe(false);
    // the reviewer's two-step: event [p1] -> schedule -> event (all) is a loosening at the last step.
    expect(loosens([at(sched("0 2 * * 1"))], [at(event())])).toBe(true);
  });

  it("what expands its power loosens: agent, capabilities, skills, scope, output, limits, releasing, instructions while on", () => {
    expect(loosens([ON()], [ON({ agent: "Other" })])).toBe(true);
    expect(loosens([ON()], [ON({ requires: ["browser"] })])).toBe(true);
    expect(loosens([ON()], [ON({ skills: ["sk_x"] })])).toBe(true);
    expect(loosens([ON({ scope: { projects: ["p1"] } })], [ON()])).toBe(true);
    expect(loosens([ON()], [ON({ output: { kind: "digest" } })])).toBe(true);
    expect(loosens([ON()], [ON({ limits: { minutes: 30, maxOutputs: 10, runsPerDay: 4 } })])).toBe(
      true,
    );
    expect(loosens([ON()], [ON({ output: queued })])).toBe(true);
    expect(loosens([ON()], [ON({ instructions: "Be brief." })])).toBe(true);
    // While off, an edit is practice: turning it on is what a person approves.
    expect(loosens([AP()], [AP({ instructions: "Be brief.", agent: "Other" })])).toBe(false);
  });

  it("records state and priority changes", () => {
    const b = ON({ output: { kind: "backlog", project: "each", state: "backlog" } });
    expect(
      cls([b], [ON({ output: { kind: "backlog", project: "each", state: "ready" } })]),
    ).toContain("loosens");
    expect(
      cls(
        [b],
        [ON({ output: { kind: "backlog", project: "each", state: "backlog", priority: 1 } })],
      ),
    ).toEqual(["neutral"]);
  });

  it("no sequence of practice or tightening saves reaches what one direct change would loosen", () => {
    // Small random walks over the fields that set reach.
    const options = {
      enabled: [false, true],
      trigger: [
        { kind: "schedule", cron: "0 2 * * 1", timezone: "UTC" },
        { kind: "schedule", cron: "0 * * * *", timezone: "UTC" },
        { kind: "event", event: "workItem.captured", projects: ["p1"] },
        { kind: "event", event: "workItem.captured" },
        { kind: "event", event: "workItem.done" },
      ],
      scope: [{ projects: ["p1"] }, { projects: ["p1", "p2"] }, { projects: "all" }],
      output: [
        { kind: "labels" },
        { kind: "digest" },
        { kind: "backlog", project: "each", state: "backlog" },
        { kind: "backlog", project: "each", state: "queued" },
      ],
      agent: ["Triager", "Other"],
      instructions: ["", "Be brief."],
      requires: [[], ["browser"]],
      limits: [
        { minutes: 30, maxOutputs: 5, runsPerDay: 4 },
        { minutes: 60, maxOutputs: 20, runsPerDay: 24 },
      ],
    } as const;
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const keys = Object.keys(options) as (keyof typeof options)[];
    const pick = (): AutopilotConfig =>
      AP(Object.fromEntries(keys.map((k) => [k, options[k][rand(options[k].length)]])));
    for (let walk = 0; walk < 300; walk++) {
      const start = rand(4) === 0 ? null : pick();
      let at = start;
      for (let step = 0; step < 6; step++) {
        const next = rand(5) === 0 ? null : pick();
        const ok = !loosens(at ? [at] : [], next ? [next] : []);
        if (!ok) continue; // only practice or tightening saves are taken
        at = next;
        expect(loosens(start ? [start] : [], at ? [at] : []), `walk ${walk} step ${step}`).toBe(
          false,
        );
      }
    }
  });
});

describe("autopilot operations", () => {
  const triager = { name: "Triager", role: "review", tier: "light", instructions: "" };
  async function withAgent(w: W) {
    await ok("agent.save", { orgId: w.orgId, baseVersion: 0, agent: triager }, w.human);
  }
  const versionOf = async (w: W) =>
    (await ok<{ version: number }>("autopilot.list", { orgId: w.orgId }, w.human)).version;

  it("an org admin adds one off (practice, at once), turns it on (approved) and off; members read them", async () => {
    const w = await world();
    await withAgent(w);
    const saved = await ok<{ version: number }>(
      "autopilot.save",
      { orgId: w.orgId, baseVersion: 1, autopilot: AP() },
      w.human,
    );
    expect(saved.version).toBe(2);
    // Turning it on loosens (what it reaches is judged then): an org admin approves it.
    const on = await call(
      "autopilot.enable",
      { orgId: w.orgId, baseVersion: 2, autopilotId: "ap_triage" },
      w.human,
    );
    if (on.status !== "pending") throw new Error("expected turning it on to wait");
    await ok(
      "approval.decide",
      { pendingActionId: on.pendingActionId, decision: "approved" },
      w.human,
    );
    const listed = await ok<{ autopilots: { id: string; enabled: boolean }[] }>(
      "autopilot.list",
      { orgId: w.orgId },
      w.human,
    );
    expect(listed.autopilots).toEqual([
      expect.objectContaining({ id: "ap_triage", enabled: true }),
    ]);
    await ok(
      "autopilot.disable",
      { orgId: w.orgId, baseVersion: 3, autopilotId: "ap_triage" },
      w.human,
    );
    const got = await ok<{ autopilot: { enabled: boolean } }>(
      "autopilot.get",
      { orgId: w.orgId, autopilotId: "ap_triage" },
      w.human,
    );
    expect(got.autopilot.enabled).toBe(false);
  });

  it("one that releases the work it files waits for an org admin, and applies on approval", async () => {
    const w = await world();
    await withAgent(w);
    const asked = await call(
      "autopilot.save",
      {
        orgId: w.orgId,
        baseVersion: 1,
        autopilot: AP({
          enabled: true,
          output: { kind: "backlog", project: w.projectId, state: "queued" },
        }),
      },
      w.human,
    );
    if (asked.status !== "pending") throw new Error("expected the save to wait");
    const pa = await rows<{ risk: string }>(
      "SELECT risk FROM core_pending_actions WHERE id = ?",
      asked.pendingActionId,
    );
    expect(pa[0]?.risk).toBe("self-modify");
    expect(await versionOf(w)).toBe(1);
    await ok(
      "approval.decide",
      { pendingActionId: asked.pendingActionId, decision: "approved" },
      w.human,
    );
    expect(await versionOf(w)).toBe(2);
  });

  it("refuses an unknown agent or project, an agent, and anyone but an org admin", async () => {
    const w = await world();
    await withAgent(w);
    expect(
      (
        await refusal(
          call(
            "autopilot.save",
            { orgId: w.orgId, baseVersion: 1, autopilot: AP({ agent: "Nobody" }) },
            w.human,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await refusal(
          call(
            "autopilot.save",
            { orgId: w.orgId, baseVersion: 1, autopilot: AP({ skills: ["sk_nothing_here"] }) },
            w.human,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await refusal(
          call(
            "autopilot.save",
            {
              orgId: w.orgId,
              baseVersion: 1,
              autopilot: AP({ scope: { projects: ["prj_elsewhere"] } }),
            },
            w.human,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // Its events must be inside its scope.
    expect(
      (
        await refusal(
          call(
            "autopilot.save",
            {
              orgId: w.orgId,
              baseVersion: 1,
              autopilot: AP({
                scope: { projects: [w.projectId] },
                trigger: { kind: "event", event: "workItem.captured", projects: ["prj_other"] },
              }),
            },
            w.human,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // The improver or any agent can't add or enable one.
    expect(
      (
        await refusal(
          call("autopilot.save", { orgId: w.orgId, baseVersion: 1, autopilot: AP() }, FOREMAN),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("deciding a waiting save names it and what it loosens (Touch ID summary)", async () => {
    const w = await world();
    await withAgent(w);
    const asked = await call(
      "autopilot.save",
      {
        orgId: w.orgId,
        baseVersion: 1,
        autopilot: AP({
          enabled: true,
          output: { kind: "backlog", project: w.projectId, state: "queued" },
        }),
      },
      w.human,
    );
    if (asked.status !== "pending") throw new Error("expected the save to wait");
    const { describeOrgConfigDecision } = await import("../src/operations/policy-summary.ts");
    const { createDb } = await import("@software-factory/db");
    const { env } = await import("cloudflare:workers");
    const pa = await rows<{ input: string }>(
      "SELECT input FROM core_pending_actions WHERE id = ?",
      asked.pendingActionId,
    );
    const summary = await describeOrgConfigDecision(
      createDb(env.DB),
      "autopilot.save",
      JSON.parse(pa[0]?.input ?? "{}"),
      "Approve",
    );
    // What it may do first, then how many loosenings.
    expect(summary).toMatch(
      /^Approve: save an org autopilot \(v1 to v2\): 0 2 \* \* \* Australia\/Sydney; files and RELEASES work; all projects; 5\/run, 4\/day, 30 min/,
    );
    // The facts come first; the name follows only where it fits (titled()).
    expect(summary).toMatch(/: 9 loosenings/);
  });
});
