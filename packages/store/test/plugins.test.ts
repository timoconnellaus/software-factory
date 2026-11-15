// Milestone 2's store: plugins, gateways (sealed secrets), item fields, cards and a plugin's stop.
import { env } from "cloudflare:workers";
import type { Actor } from "@software-factory/flow";
import { describe, expect, it } from "vitest";
import {
  addCard,
  applyEvent,
  createItem,
  createProject,
  createWorkflow,
  declaredFields,
  deleteGateway,
  enabledPlugins,
  gatewayForHost,
  getItem,
  getPlugin,
  itemRuns,
  listGateways,
  StoreError,
  saveGateway,
  savePlugin,
  setField,
  setPluginEnabled,
  setPluginLastError,
  stopItem,
  timeline,
} from "../src/index.ts";

const d1 = env.DB;
const sam: Actor = { kind: "person", id: "sam" };
const org = () => `org_${crypto.randomUUID()}`;

async function item(orgId: string) {
  const wf = await createWorkflow(d1, orgId, {
    name: "Write, done",
    statuses: [
      { id: "write", name: "Write", owner: { kind: "person", userId: "sam" } },
      { id: "done", name: "Done", owner: { kind: "none" } },
    ],
  });
  if (!wf.ok) throw new Error("refused");
  const project = await createProject(d1, {
    orgId,
    name: "P",
    key: "P",
    workflowId: wf.workflow.id,
  });
  return createItem(d1, {
    orgId,
    projectId: project.id,
    title: "t",
    body: "",
    createdBy: "sam",
    fields: { customer: "Acme" },
  });
}

const plugin = (orgId: string, name: string, code = "export default {}") =>
  savePlugin(d1, {
    orgId,
    name,
    request: "Show the customer.",
    code,
    fields: [{ id: "customer", label: "Customer", type: "text" }],
    hooks: ["entered"],
    createdBy: "sam",
  });

describe("plugins", () => {
  it("saves by name: a replace keeps its id, key and creator and clears its last error", async () => {
    const orgId = org();
    const first = await plugin(orgId, "customers");
    expect(first).toMatchObject({ enabled: true, lastError: null, hooks: ["entered"] });
    expect(first.triggerKey).toMatch(/^[0-9a-f]{48}$/);
    await setPluginLastError(d1, first.id, "boom");
    expect((await getPlugin(d1, orgId, "customers"))?.lastError).toBe("boom");
    const second = await plugin(orgId, "customers", "export default { fields: [] }");
    expect(second).toMatchObject({
      id: first.id,
      triggerKey: first.triggerKey,
      lastError: null,
      code: "export default { fields: [] }",
    });
  });

  it("declares the fields of enabled plugins only, first name wins", async () => {
    const orgId = org();
    await plugin(orgId, "a");
    await plugin(orgId, "b");
    expect(await declaredFields(d1, orgId)).toEqual([
      { id: "customer", label: "Customer", type: "text" },
    ]);
    await setPluginEnabled(d1, orgId, "a", false);
    await setPluginEnabled(d1, orgId, "b", false);
    expect(await declaredFields(d1, orgId)).toEqual([]);
    expect(await enabledPlugins(d1, orgId)).toEqual([]);
  });
});

describe("gateways", () => {
  it("seals the secret, never returns it, and opens it for the host", async () => {
    const orgId = org();
    const saved = await saveGateway(d1, "k", {
      orgId,
      name: "blog",
      baseUrl: "https://blog.example/api",
      auth: { kind: "bearer" },
      secret: "s3cret",
    });
    expect(saved).toMatchObject({ hasSecret: true });
    expect(JSON.stringify(saved)).not.toContain("s3cret");
    const raw = await d1
      .prepare("SELECT secret FROM flow_gateways WHERE id = ?")
      .bind(saved.id)
      .first<{ secret: string }>();
    expect(raw?.secret).toMatch(/^v1:/);
    expect(raw?.secret).not.toContain("s3cret");
    expect((await gatewayForHost(d1, "k", orgId, "blog"))?.secret).toBe("s3cret");
    // The wrong key can't open it.
    await expect(gatewayForHost(d1, "other", orgId, "blog")).rejects.toThrow();
    // A save without a secret keeps it.
    await saveGateway(d1, "k", {
      orgId,
      name: "blog",
      baseUrl: "https://blog.example/v2",
      auth: { kind: "bearer" },
    });
    expect((await gatewayForHost(d1, "k", orgId, "blog"))?.secret).toBe("s3cret");
    expect((await listGateways(d1, orgId)).map((g) => g.baseUrl)).toEqual([
      "https://blog.example/v2",
    ]);
    await deleteGateway(d1, orgId, "blog");
    expect(await listGateways(d1, orgId)).toEqual([]);
  });

  it("refuses a secret with no key, and keeps a gateway without auth working", async () => {
    const orgId = org();
    const refused = saveGateway(d1, undefined, {
      orgId,
      name: "x",
      baseUrl: "https://x.example",
      auth: { kind: "bearer" },
      secret: "s",
    });
    await expect(refused).rejects.toThrow(/FLOW_GATEWAY_KEY/);
    await expect(refused).rejects.toBeInstanceOf(StoreError);
    await saveGateway(d1, undefined, {
      orgId,
      name: "open",
      baseUrl: "https://open.example",
      auth: { kind: "none" },
    });
    expect((await gatewayForHost(d1, undefined, orgId, "open"))?.secret).toBeNull();
  });
});

describe("item fields, cards and a plugin's stop", () => {
  it("sets and clears fields, and adds a card to the timeline", async () => {
    const it0 = await item(org());
    expect(it0.fields).toEqual({ customer: "Acme" });
    await setField(d1, it0.id, "amount", 12.5);
    await setField(d1, it0.id, "customer", null);
    expect((await getItem(d1, it0.id))?.fields).toEqual({ amount: 12.5 });
    await expect(setField(d1, it0.id, 'bad"id', 1)).rejects.toBeInstanceOf(StoreError);
    await addCard(d1, it0.id, { kind: "plugin", id: "p" }, { kind: "link", title: "Posted" });
    const last = (await timeline(d1, it0.id)).entries.at(-1);
    expect(last).toMatchObject({ kind: "card", data: { kind: "link", title: "Posted" } });
  });

  it("stops an item as a failed run does, and a retry runs the status again", async () => {
    const it0 = await item(org());
    const stopped = await stopItem(d1, it0.id, 'Plugin "p" failed: boom');
    expect(stopped).toMatchObject({ error: 'Plugin "p" failed: boom', waiting: { on: "nothing" } });
    expect((await getItem(d1, it0.id))?.error).toBe('Plugin "p" failed: boom');
    const retried = await applyEvent(d1, it0.id, { type: "retried", by: sam }, sam);
    expect(retried).toMatchObject({ error: null, waiting: { on: "person", userId: "sam" } });
    expect(await itemRuns(d1, it0.id)).toEqual([]);
  });
});
