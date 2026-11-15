// Milestone 2's operations without a Worker Loader (the engine's tests run plugins for real): an
// agent caller's scope, gateways, fields, and what an engine with no loader says.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Caller, type CallResult, call } from "../src/index.ts";

const d1 = env.DB;

async function member() {
  const orgId = `org_${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
      )
      .bind(userId, `${userId}@example.com`, now, now),
    d1
      .prepare(
        "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Acme', ?, 'team', ?)",
      )
      .bind(orgId, orgId, now),
    d1
      .prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      )
      .bind(`mem_${crypto.randomUUID()}`, orgId, userId, now),
  ]);
  const as = (op: string, input: Record<string, unknown>, actor?: Caller) =>
    call(op, { orgId, ...input }, { d1, actor: actor ?? { kind: "person", id: userId } });
  return { orgId, userId, as };
}

function ok<T = Record<string, unknown>>(r: CallResult): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

describe("milestone 2 operations", () => {
  it("lets an agent act in its run's org only, for the person it works for", async () => {
    const o = await member();
    const agent = ok<{ id: string; mcp: string[] }>(
      await o.as("flow.agent.create", { name: "Builder", instructions: "", mcp: ["factory"] }),
    );
    expect(agent.mcp).toEqual(["factory"]);
    const caller: Caller = { kind: "agent", id: agent.id, orgId: o.orgId, onBehalfOf: o.userId };
    const wf = ok<{ id: string }>(
      await o.as(
        "flow.workflow.create",
        { name: "One", statuses: [{ id: "a", name: "A", owner: { kind: "none" } }] },
        caller,
      ),
    );
    const project = ok<{ id: string }>(
      await o.as("flow.project.create", { name: "P", key: "P", workflowId: wf.id }, caller),
    );
    const item = ok<{ createdBy: string }>(
      await o.as("flow.item.create", { projectId: project.id, title: "t" }, caller),
    );
    expect(item.createdBy).toBe(o.userId);
    const other = await member();
    const out = await other.as("flow.project.list", {}, caller);
    expect(out).toMatchObject({ ok: false, error: { code: "forbidden" } });
    // Updating an agent without `mcp` keeps it.
    const kept = ok<{ mcp: string[] }>(
      await o.as("flow.agent.update", { agentId: agent.id, name: "B", instructions: "x" }),
    );
    expect(kept.mcp).toEqual(["factory"]);
  });

  it("refuses a gateway secret when the engine has no key, and never lists one", async () => {
    const o = await member();
    const refused = await o.as("flow.gateway.save", {
      name: "blog",
      baseUrl: "https://blog.example",
      auth: { kind: "bearer" },
      secret: "s",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const keyed = await call(
      "flow.gateway.save",
      {
        orgId: o.orgId,
        name: "blog",
        baseUrl: "https://blog.example",
        auth: { kind: "header", header: "X-Api-Key" },
        secret: "s3cret",
      },
      { d1, host: { DB: d1, FLOW_GATEWAY_KEY: "k" }, actor: { kind: "person", id: o.userId } },
    );
    expect(ok(keyed)).toMatchObject({ name: "blog", hasSecret: true });
    const listed = ok(await o.as("flow.gateway.list", {}));
    expect(JSON.stringify(listed)).not.toContain("s3cret");
  });

  it("says plainly that plugins can't be saved without a Worker Loader", async () => {
    const o = await member();
    const out = await o.as("flow.plugin.save", { name: "p", code: "export default {}" });
    expect(out).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
