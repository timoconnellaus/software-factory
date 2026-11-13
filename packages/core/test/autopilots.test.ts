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

describe("how a change to an autopilot classifies (ADR 0514 §5)", () => {
  const cls = (before: AutopilotConfig[], after: AutopilotConfig[]) =>
    autopilotImpact(before, after).map((c) => c.class);
  const queued = { kind: "backlog", project: "each", state: "queued" };

  it("adding or enabling one is practice, unless it releases work", () => {
    expect(cls([], [AP()])).toEqual(["neutral"]);
    expect(cls([], [AP({ enabled: true })])).toEqual(["neutral"]);
    expect(cls([], [AP({ enabled: true, output: queued })])).toEqual(["loosens"]);
    expect(cls([AP({ output: queued })], [AP({ enabled: true, output: queued })])).toContain(
      "loosens",
    );
    expect(cls([AP({ enabled: true })], [AP()])).toEqual(["tightens"]);
  });

  it("widening its reach loosens; narrowing tightens; instructions are practice", () => {
    const some = { projects: ["p1"] };
    expect(cls([AP({ scope: some })], [AP({ scope: { projects: "all" } })])).toContain("loosens");
    expect(cls([AP()], [AP({ scope: some })])).toContain("tightens");
    expect(cls([AP()], [AP({ limits: { minutes: 30, maxOutputs: 10, runsPerDay: 4 } })])).toContain(
      "loosens",
    );
    expect(cls([AP()], [AP({ output: { kind: "digest" } })])).toContain("loosens");
    expect(cls([AP()], [AP({ instructions: "Be brief." })])).toEqual(["neutral"]);
    expect(cls([AP({ enabled: true })], [])).toEqual(["tightens"]);
  });
});

describe("autopilot operations", () => {
  const triager = { name: "Triager", role: "review", tier: "light", instructions: "" };
  async function withAgent(w: W) {
    await ok("agent.save", { orgId: w.orgId, baseVersion: 0, agent: triager }, w.human);
  }
  const versionOf = async (w: W) =>
    (await ok<{ version: number }>("autopilot.list", { orgId: w.orgId }, w.human)).version;

  it("an org admin adds one (practice, at once), turns it on and off; members read them", async () => {
    const w = await world();
    await withAgent(w);
    const saved = await ok<{ version: number }>(
      "autopilot.save",
      { orgId: w.orgId, baseVersion: 1, autopilot: AP() },
      w.human,
    );
    expect(saved.version).toBe(2);
    await ok(
      "autopilot.enable",
      { orgId: w.orgId, baseVersion: 2, autopilotId: "ap_triage" },
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
    expect(summary).toMatch(/^Approve: save an org autopilot \(v1 to v2\).*releasing/);
  });
});
