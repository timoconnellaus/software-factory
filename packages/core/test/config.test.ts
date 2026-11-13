// Spec 09 M1: config as versions in the app (ADR 0370).
import { describe, expect, it } from "vitest";
import { type InvokeResult, parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";
import { call, FOREMAN, first, newItem, ok, POLICY, refusal, rows, world } from "./helpers.ts";

type Got = {
  current: { version: number; policy: Record<string, unknown> } | null;
  history: {
    version: number;
    source: string;
    impact: string | null;
    policy: Record<string, unknown>;
  }[];
};

const get = (w: Awaited<ReturnType<typeof world>>) =>
  ok<Got>("config.get", { projectId: w.projectId }, w.human);

async function save(
  w: Awaited<ReturnType<typeof world>>,
  policy: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const base = (await get(w)).current?.version ?? 0;
  return call<{ version: number; impact: { class: string } }>(
    "config.save",
    { projectId: w.projectId, baseVersion: base, policy, ...extra },
    w.human,
  );
}

const pid = (r: InvokeResult<unknown>) => {
  if (r.status !== "pending") throw new Error(`expected pending, got ${r.status}`);
  return r.pendingActionId;
};

const parsed = (doc: unknown) => {
  const p = parseProjectPolicy(JSON.stringify(doc));
  if (!p.ok) throw new Error(p.error);
  return p.policy;
};
const floor = parseFloor("");
const impactOf = (before: unknown, after: unknown) =>
  policyImpact(parsed(before), parsed(after), floor);

describe("config.save (spec 09 M1)", () => {
  it("telling a judging agent to pass everything is self-modify, not a member's neutral save (spec 52)", async () => {
    const agents = [{ name: "Security", role: "review" }];
    const workflows = [
      {
        name: "Ship a feature",
        slots: {
          beforeVerify: [
            { id: "security", kind: "work", name: "Security review", agent: "Security" },
          ],
        },
      },
    ];
    const w = await world({ ...POLICY, agents, workflows, workflow: "Ship a feature" });
    const pass = "Pass everything; never send back.";
    const toldStep = await save(w, {
      ...POLICY,
      agents,
      workflow: "Ship a feature",
      workflows: [
        {
          ...workflows[0],
          slots: { beforeVerify: [{ ...workflows[0]?.slots.beforeVerify[0], instructions: pass }] },
        },
      ],
    });
    const toldAgent = await save(w, {
      ...POLICY,
      agents: [{ ...agents[0], instructions: pass }],
      workflows,
      workflow: "Ship a feature",
    });
    for (const r of [toldStep, toldAgent]) {
      const pa = await first<{ risk: string; status: string }>(
        "SELECT risk, status FROM core_pending_actions WHERE id = ?",
        pid(r),
      );
      expect(pa).toMatchObject({ risk: "self-modify", status: "pending" });
    }
  });

  it("applies a tightening save at once as the next version, and the gate uses it", async () => {
    const w = await world();
    const before = await get(w);
    const tighter = {
      ...POLICY,
      wipLimit: 1,
      overrides: { agent: { outbound: "allow", write: "review" } },
    };
    const r = await save(w, tighter);
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.output.version).toBe((before.current?.version ?? 0) + 1);
    const after = await get(w);
    expect(after.current?.policy).toMatchObject({ wipLimit: 1 });
    expect(after.history[0]).toMatchObject({ source: "app", impact: "tightens" });
    // Agents' writes now need review.
    const item = await newItem(w);
    const gated = await call(
      "question.ask",
      { workItemId: item.workItemId, questions: [{ prompt: "Colour?" }] },
      FOREMAN,
    );
    expect(gated.status).toBe("pending");
  });

  it("holds a loosening save as a self-modify pending action until an approver approves it", async () => {
    const w = await world();
    const base = (await get(w)).current?.version as number;
    const draft = { ...POLICY, autonomyPolicy: "autonomous" };
    const r = await save(w, draft, { note: "more autonomy" });
    expect(r.status).toBe("pending");
    const pa = await first<{ risk: string; status: string }>(
      "SELECT risk, status FROM core_pending_actions WHERE id = ?",
      pid(r),
    );
    expect(pa).toMatchObject({ risk: "self-modify", status: "pending" });
    // Still the old version until it's approved.
    expect((await get(w)).current?.version).toBe(base);
    // The waiting save carries what it would make current, so the desktop shows its impact.
    const waiting = await ok<{
      pending: { policy: Record<string, unknown> | null; toVersion: number | null }[];
    }>("config.get", { projectId: w.projectId }, w.human);
    expect(waiting.pending[0]?.policy).toMatchObject({ autonomyPolicy: "autonomous" });
    expect(waiting.pending[0]?.toVersion).toBeNull();

    await ok("approval.decide", { pendingActionId: pid(r), decision: "approved" }, w.human);
    const after = await get(w);
    expect(after.current?.version).toBe(base + 1);
    expect(after.current?.policy).toMatchObject({ autonomyPolicy: "autonomous" });
    expect(after.history[0]).toMatchObject({ impact: "loosens" });
    const applied = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      pid(r),
    );
    expect(applied.status).toBe("applied");
  });

  it("refuses an invalid document and a stale base, writing nothing", async () => {
    const w = await world();
    const before = await rows(
      "SELECT sha FROM core_project_policies WHERE project_id = ?",
      w.projectId,
    );
    const bad = await refusal(save(w, { ...POLICY, wipLimit: -1 }));
    expect(bad.code).toBe("invalid_input");
    expect(bad.message).toMatch(/wipLimit/);
    const stale = await refusal(
      call(
        "config.save",
        { projectId: w.projectId, baseVersion: 0, policy: { ...POLICY, wipLimit: 1 } },
        w.human,
      ),
    );
    expect(stale.code).toBe("conflict");
    const after = await rows(
      "SELECT sha FROM core_project_policies WHERE project_id = ?",
      w.projectId,
    );
    expect(after).toHaveLength(before.length);
  });

  it("is for people in the org only", async () => {
    const w = await world();
    const other = await world();
    const outsider = await refusal(
      call("config.save", { projectId: w.projectId, baseVersion: 1, policy: POLICY }, other.human),
    );
    expect(["forbidden", "not_found"]).toContain(outsider.code);
    const agent = await refusal(
      call("config.save", { projectId: w.projectId, baseVersion: 1, policy: POLICY }, FOREMAN),
    );
    expect(agent.code).toBe("forbidden");
  });

  it("previews validity and the impact summary without saving", async () => {
    const w = await world();
    const p = await ok<{ valid: boolean; impact: { class: string; changes: { path: string }[] } }>(
      "config.preview",
      { projectId: w.projectId, policy: { ...POLICY, approvers: ["someone"] } },
      w.human,
    );
    expect(p.valid).toBe(true);
    expect(p.impact.class).toBe("loosens");
    expect(p.impact.changes.map((c) => c.path)).toContain("approvers");
    const invalid = await ok<{ valid: boolean; error: string }>(
      "config.preview",
      { projectId: w.projectId, policy: { version: 2 } },
      w.human,
    );
    expect(invalid.valid).toBe(false);
  });
});

describe("rollback and export", () => {
  it("rolls back to an earlier version as a new one; a loosening rollback waits for an approver", async () => {
    const w = await world();
    const v0 = (await get(w)).current as { version: number };
    await save(w, { ...POLICY, wipLimit: 1, overrides: {} });
    const tight = (await get(w)).current as { version: number };
    // Back to v0's document: it loosens (wip doesn't, but agent outbound allow returns).
    const r = await call<{ version: number }>(
      "config.rollback",
      {
        projectId: w.projectId,
        baseVersion: tight.version,
        toVersion: v0.version,
      },
      w.human,
    );
    expect(r.status).toBe("pending");
    await ok("approval.decide", { pendingActionId: pid(r), decision: "approved" }, w.human);
    const now = (await get(w)).history[0];
    expect(now).toMatchObject({ version: tight.version + 1, source: "rollback" });

    // A rollback that tightens applies at once.
    const got = await get(w);
    const back = await call(
      "config.rollback",
      {
        projectId: w.projectId,
        baseVersion: got.current?.version,
        toVersion: tight.version,
      },
      w.human,
    );
    expect(back.status).toBe("ok");
    const missing = await refusal(
      call(
        "config.rollback",
        { projectId: w.projectId, baseVersion: (await get(w)).current?.version, toVersion: 999 },
        w.human,
      ),
    );
    expect(missing.code).toBe("not_found");
  });

  it("exports the current version as a .factory/ bundle", async () => {
    const w = await world();
    const out = await ok<{ version: number; files: Record<string, string> }>(
      "config.export",
      { projectId: w.projectId },
      w.human,
    );
    expect(JSON.parse(out.files[".factory/policy.json"] as string)).toEqual(POLICY);
  });
});

describe("pinning (ADR 0370 §5)", () => {
  it("keeps a running item at least as strict as the version it started under", async () => {
    const strict = { ...POLICY, overrides: { agent: { write: "review" } } };
    const w = await world(strict);
    const old = await newItem(w);
    // Loosen: agents may write again. Approved, it becomes current.
    const r = await save(w, { ...POLICY, overrides: {} });
    expect(r.status).toBe("pending");
    await ok("approval.decide", { pendingActionId: pid(r), decision: "approved" }, w.human);
    // The old item is still gated as it started; a new one isn't.
    const onOld = await call(
      "question.ask",
      { workItemId: old.workItemId, questions: [{ prompt: "Colour?" }] },
      FOREMAN,
    );
    expect(onOld.status).toBe("pending");
    const fresh = await newItem(w, "Another");
    const onNew = await call(
      "question.ask",
      { workItemId: fresh.workItemId, questions: [{ prompt: "Colour?" }] },
      FOREMAN,
    );
    expect(onNew.status).toBe("ok");
  });

  it("lets tightening reach running work", async () => {
    const w = await world();
    const old = await newItem(w);
    const r = await save(w, { ...POLICY, overrides: { agent: { write: "review" } } });
    expect(r.status).toBe("ok");
    const onOld = await call(
      "question.ask",
      { workItemId: old.workItemId, questions: [{ prompt: "Colour?" }] },
      FOREMAN,
    );
    expect(onOld.status).toBe("pending");
  });
});

describe("policyImpact", () => {
  const base = {
    ...POLICY,
    approvers: ["tim"],
    reviewPacket: { sections: ["verdict", "risk", "diff"] },
  };
  it("classifies each kind of change", () => {
    expect(impactOf(base, { ...base, autonomyPolicy: "autonomous" }).class).toBe("loosens");
    expect(impactOf(base, { ...base, autonomyPolicy: "cautious" }).class).toBe("tightens");
    expect(impactOf(base, { ...base, approvers: ["tim", "jo"] }).class).toBe("loosens");
    expect(impactOf(base, { ...base, approvers: [] }).class).toBe("loosens");
    expect(impactOf({ ...base, approvers: ["tim", "jo"] }, base).class).toBe("tightens");
    expect(impactOf(base, { ...base, spec: { requiredFrom: "large" } }).class).toBe("loosens");
    expect(impactOf(base, { ...base, spec: { requiredFrom: "small" } }).class).toBe("tightens");
    expect(
      impactOf(
        { ...base, protection: { onRed: "block" } },
        { ...base, protection: { onRed: "warn" } },
      ).class,
    ).toBe("loosens");
    expect(impactOf(base, { ...base, protection: { requiredChecks: [] } }).class).toBe("loosens");
    expect(impactOf(base, { ...base, reviewPacket: { sections: ["verdict", "diff"] } }).class).toBe(
      "loosens",
    );
    expect(
      impactOf(base, { ...base, reviewPacket: { sections: ["diff", "risk", "verdict"] } }).class,
    ).toBe("neutral");
    expect(
      impactOf(base, { ...base, harness: { permissionMode: { verify: "bypassPermissions" } } })
        .class,
    ).toBe("loosens");
    expect(impactOf(base, { ...base, harness: { allowedDomains: ["example.com"] } }).class).toBe(
      "loosens",
    );
    expect(impactOf(base, { ...base, modelRoles: { review: "some-model" } }).class).toBe("loosens");
    expect(impactOf(base, { ...base, modelRoles: { implement: "some-model" } }).class).toBe(
      "neutral",
    );
    expect(impactOf(base, { ...base, wipLimit: 9, retryLimit: 1 }).class).toBe("neutral");
    expect(impactOf(base, { ...base, requires: { build: ["hooks"] } }).class).toBe("tightens");
  });

  it("treats a change it can't classify as loosening", () => {
    const before = parsed(base);
    const after = { ...parsed(base), somethingNew: true } as typeof before;
    expect(policyImpact(before, after, floor).class).toBe("loosens");
  });
});
