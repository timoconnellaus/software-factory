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
    const otherValue = await refusal(
      call("override.approve", { ...base, ...s, value: "small" }, w.human),
    );
    expect(otherValue.code).toBe("conflict");
    const otherVersion = await refusal(
      call("override.approve", { ...base, ...s, configVersion: s.configVersion + 1 }, w.human),
    );
    expect(otherVersion.code).toBe("conflict");
    expect(await requiredFrom(w)).toBe("small");
  });

  it("an org admin approves an existing looser override for the current org version, in one step", async () => {
    const w = await world();
    await unapprovedOverride(w);
    expect(await requiredFrom(w)).toBe("small");
    const out = await ok<{ approved: boolean; orgVersion: number; value: unknown }>(
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
    expect(out).toEqual({ approved: true, orgVersion: 2, value: "medium" });
    expect(await requiredFrom(w)).toBe("medium");
  });

  it("refuses a stale org version, an override that isn't looser, and anyone but an org admin", async () => {
    const w = await world();
    await unapprovedOverride(w);
    const stale = await refusal(
      call(
        "override.approve",
        {
          projectId: w.projectId,
          stageId: "spec",
          setting: "requiredFrom",
          orgVersion: 1,
          ...(await seen(w)),
        },
        w.human,
      ),
    );
    expect(stale.code).toBe("conflict");
    const nothing = await refusal(
      call(
        "override.approve",
        {
          projectId: w.projectId,
          stageId: "build",
          setting: "retryLimit",
          orgVersion: 2,
          ...(await seen(w)),
        },
        w.human,
      ),
    );
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
    // An org admin who isn't the owner may.
    const admin = await member(w, "admin");
    await ok(
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
});
