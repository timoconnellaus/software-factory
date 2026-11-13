// An org admin approves a project's existing looser override in one step (`override.approve`, review
// of spec 52 (d2)), instead of the project re-saving its config so a pending action can be approved.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { invoke, resolveScope } from "../src/index.ts";
import { NOTIFY_ADMINS } from "../src/operations/workflows.ts";
import { SOFTWARE, type WorkflowDefinition } from "../src/stages/index.ts";
import { call, deps, ok, POLICY, refusal, rows, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const SHIP: WorkflowDefinition = {
  ...SOFTWARE,
  id: "wf_ship_it",
  name: "Ship it",
  template: { id: SOFTWARE.id, version: 1 },
};
const withSpec = (requiredFrom: string): WorkflowDefinition => ({
  ...SHIP,
  stages: SHIP.stages.map((s) => (s.id === "spec" ? { ...s, settings: { requiredFrom } } : s)),
});

async function saveConfig(w: W, policy: Record<string, unknown>) {
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  return call(
    "config.save",
    { projectId: w.projectId, baseVersion: got.current?.version ?? 0, policy },
    w.human,
  );
}

/**
 * A project whose `requiredFrom: medium` override was stricter than the org's `large`, until the org
 * tightened to `small` (v2): now it is looser, with no approval, so `small` applies.
 */
async function unapprovedOverride(w: W) {
  const first = await call(
    "workflow.save",
    { orgId: w.orgId, baseVersion: 0, workflow: withSpec("large") },
    w.human,
  );
  if (first.status === "pending")
    await ok(
      "approval.decide",
      { pendingActionId: first.pendingActionId, decision: "approved" },
      w.human,
    );
  const saved = await saveConfig(w, {
    ...POLICY,
    workflow: SHIP.id,
    workflowOverrides: { spec: { requiredFrom: "medium" } },
  });
  expect(saved.status).toBe("ok");
  const r = await call(
    "workflow.save",
    { orgId: w.orgId, baseVersion: 1, workflow: withSpec("small") },
    w.human,
  );
  expect(r.status).toBe("ok");
}

const requiredFrom = async (w: W) =>
  (await resolveScope(createDb(env.DB), { projectId: w.projectId })).policy?.spec.requiredFrom;

async function member(w: W, role: "member" | "admin") {
  const id = `usr_${role}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, role, `${id}@example.com`, `gh-${id}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(`mem_${id}`, w.orgId, id, role, now),
  ]);
  return { type: "human" as const, id };
}

/** What the person was shown: the override's value and the project's config version. */
async function seen(w: Awaited<ReturnType<typeof world>>) {
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  return { value: "medium", configVersion: got.current?.version ?? 0 };
}

/** Asks for an approval, then an org admin approves it: the refusal it applies with. */
async function decided(w: Awaited<ReturnType<typeof world>>, input: Record<string, unknown>) {
  const asked = await call("override.approve", input, w.human);
  if (asked.status !== "pending") throw new Error("expected the approval to wait");
  return refusal(
    call(
      "approval.decide",
      { pendingActionId: asked.pendingActionId, decision: "approved" },
      w.human,
    ),
  );
}

describe("override.approve", () => {
  it("binds the value and the config version the person was shown (review of #156)", async () => {
    const w = await world();
    await unapprovedOverride(w);
    const base = {
      projectId: w.projectId,
      stageId: "spec",
      setting: "requiredFrom",
      orgVersion: 2,
    };
    const s = await seen(w);
    // Checked when it applies, at the org admin's decision.
    expect((await decided(w, { ...base, ...s, value: "small" })).code).toBe("conflict");
    expect((await decided(w, { ...base, ...s, configVersion: s.configVersion + 1 })).code).toBe(
      "conflict",
    );
    expect(await requiredFrom(w)).toBe("small");
  });

  it("an org admin's approval of an existing looser override is self-modify: it applies once an org admin decides it", async () => {
    const w = await world();
    await unapprovedOverride(w);
    expect(await requiredFrom(w)).toBe("small");
    const asked = await call(
      "override.approve",
      {
        projectId: w.projectId,
        stageId: "spec",
        setting: "requiredFrom",
        orgVersion: 2,
        ...(await seen(w)),
      },
      w.human,
    );
    if (asked.status !== "pending") throw new Error("expected the approval to wait");
    const pa = await rows<{ risk: string; decider: string | null }>(
      "SELECT risk, decider FROM core_pending_actions WHERE id = ?",
      asked.pendingActionId,
    );
    expect(pa[0]).toEqual({ risk: "self-modify", decider: "org-admin" });
    expect(await requiredFrom(w)).toBe("small");
    await ok(
      "approval.decide",
      { pendingActionId: asked.pendingActionId, decision: "approved" },
      w.human,
    );
    expect(await requiredFrom(w)).toBe("medium");
  });

  it("refuses a stale org version, an override that isn't looser, and anyone but an org admin", async () => {
    const w = await world();
    await unapprovedOverride(w);
    // Asked and decided: what it would apply is checked when it applies.
    const decide = async (input: Record<string, unknown>, actor = w.human) => {
      const asked = await call(
        "override.approve",
        { projectId: w.projectId, ...(await seen(w)), ...input },
        actor,
      );
      if (asked.status !== "pending") throw new Error("expected the approval to wait");
      return refusal(
        call(
          "approval.decide",
          { pendingActionId: asked.pendingActionId, decision: "approved" },
          w.human,
        ),
      );
    };
    expect((await decide({ stageId: "spec", setting: "requiredFrom", orgVersion: 1 })).code).toBe(
      "conflict",
    );
    const nothing = await decide({ stageId: "build", setting: "retryLimit", orgVersion: 2 });
    expect(nothing.code).toBe("invalid_input");
    expect(nothing.message).toMatch(/nothing to approve/);
    const plain = await member(w, "member");
    const forbidden = await refusal(
      call(
        "override.approve",
        {
          projectId: w.projectId,
          stageId: "spec",
          setting: "requiredFrom",
          orgVersion: 2,
          ...(await seen(w)),
        },
        plain,
      ),
    );
    expect(forbidden.code).toBe("forbidden");
    expect(await requiredFrom(w)).toBe("small");
    // An org admin who isn't the owner may ask, and an org admin decides.
    const admin = await member(w, "admin");
    const asked = await call(
      "override.approve",
      {
        projectId: w.projectId,
        stageId: "spec",
        setting: "requiredFrom",
        orgVersion: 2,
        ...(await seen(w)),
      },
      admin,
    );
    if (asked.status !== "pending") throw new Error("expected the approval to wait");
    await ok(
      "approval.decide",
      { pendingActionId: asked.pendingActionId, decision: "approved" },
      admin,
    );
    expect(await requiredFrom(w)).toBe("medium");
  });

  it("is decided in the app: never from a desktop device, the CLI or MCP", async () => {
    const w = await world();
    await unapprovedOverride(w);
    for (const surface of ["desktop", "cli", "mcp"] as const) {
      const refused = await refusal(
        invoke(
          deps,
          "override.approve",
          {
            projectId: w.projectId,
            stageId: "spec",
            setting: "requiredFrom",
            orgVersion: 2,
            ...(await seen(w)),
          },
          { actor: w.human, origin: { surface } },
        ),
      );
      expect(refused.code, surface).toBe("forbidden");
    }
    expect(await requiredFrom(w)).toBe("small");
  });
});

describe("an org change's notices are bounded (review of #128)", () => {
  it("tells at most NOTIFY_ADMINS of the org's admins, owners first", async () => {
    const w = await world();
    const admins: { id: string }[] = [];
    for (let i = 0; i < NOTIFY_ADMINS + 2; i++) admins.push(await member(w, "admin"));
    await unapprovedOverride(w);
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'workflow.overrideNeedsApproval') > 0",
    );
    const recipients = told
      .map((t) => (JSON.parse(t.payload) as { userId?: string }).userId)
      .filter((id): id is string => !!id && (id === w.userId || admins.some((a) => a.id === id)));
    expect(recipients.length).toBe(NOTIFY_ADMINS);
    expect(recipients).toContain(w.userId);
  });

  it("the decision that applies it names what it loosens in its Touch ID summary (review of #185)", async () => {
    const w = await world();
    await unapprovedOverride(w);
    const asked = await call(
      "override.approve",
      {
        projectId: w.projectId,
        stageId: "spec",
        setting: "requiredFrom",
        orgVersion: 2,
        ...(await seen(w)),
      },
      w.human,
    );
    if (asked.status !== "pending") throw new Error("expected the approval to wait");
    const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'M5', 'key', 'secure-enclave', ?, NULL, NULL)",
    )
      .bind(id, w.userId, new Date().toISOString())
      .run();
    const challenge = await invoke(
      deps,
      "presence.challenge",
      {
        op: "approval.decide",
        input: { pendingActionId: asked.pendingActionId, decision: "approved" },
      },
      { actor: w.human, origin: { surface: "desktop", deviceId: id } },
    );
    if (challenge.status !== "ok") throw new Error("expected a challenge");
    const { summary } = challenge.output as { summary: string };
    expect(summary).toMatch(
      /^Approve a looser override \(config v\d+, org v2\): loosens: spec requiredFrom from the org's small to medium/,
    );
  });
});
