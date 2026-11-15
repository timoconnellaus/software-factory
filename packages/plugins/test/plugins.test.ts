// The host on its own, against real D1 and a real Worker Loader (workerd under
// @cloudflare/vitest-plugin): loading, inspecting, dispatching, deadlines and URL joining.
import { env } from "cloudflare:workers";
import { createItem, createProject, createWorkflow, getPlugin } from "@software-factory/store";
import { describe, expect, it } from "vitest";
import {
  dispatch,
  inspectPlugin,
  joinUrl,
  loaderId,
  NoLoaderError,
  savePluginChecked,
  withDeadline,
} from "../src/index.ts";

const org = () => `org_${crypto.randomUUID()}`;

async function item(orgId: string) {
  const wf = await createWorkflow(env.DB, orgId, {
    name: "A, B",
    statuses: [
      { id: "a", name: "A", owner: { kind: "none" } },
      { id: "b", name: "B", owner: { kind: "none" } },
    ],
  });
  if (!wf.ok) throw new Error("refused");
  const project = await createProject(env.DB, {
    orgId,
    name: "P",
    key: "P",
    workflowId: wf.workflow.id,
  });
  return createItem(env.DB, { orgId, projectId: project.id, title: "t", body: "", createdBy: "u" });
}

describe("joinUrl", () => {
  it("puts the path under the base, and refuses one that leaves it", () => {
    expect(joinUrl("https://x.test/api", "/posts?a=1").href).toBe("https://x.test/api/posts?a=1");
    expect(joinUrl("https://x.test/api/", "posts").href).toBe("https://x.test/api/posts");
    expect(joinUrl("https://x.test", "").href).toBe("https://x.test/");
    for (const bad of ["../x", "/a/../../x", "https://evil.test/", "//evil.test/x", "%2e%2e/x"]) {
      expect(() => joinUrl("https://x.test/api", bad), bad).toThrow();
    }
  });
});

describe("the host", () => {
  it("reads what a module declares, and refuses one that doesn't load", async () => {
    const ok = await inspectPlugin(
      env,
      org(),
      `export default { fields: [{ id: "n", label: "N", type: "number" }], on: { entered() {}, trigger() {} } };`,
    );
    expect(ok).toEqual({
      ok: true,
      declaration: {
        fields: [{ id: "n", label: "N", type: "number" }],
        hooks: ["entered", "trigger"],
      },
    });
    expect(await inspectPlugin(env, org(), "export default 3;")).toMatchObject({ ok: false });
    expect(await inspectPlugin(env, org(), "throw new Error('at load')")).toMatchObject({
      ok: false,
      error: expect.stringContaining("at load"),
    });
    await expect(inspectPlugin({ DB: env.DB }, org(), "export default {}")).rejects.toBeInstanceOf(
      NoLoaderError,
    );
  });

  it("keys a worker by its org and code", async () => {
    expect(await loaderId("o", "a")).toBe(await loaderId("o", "a"));
    expect(await loaderId("o", "a")).not.toBe(await loaderId("o", "b"));
    expect(await loaderId("o", "a")).not.toBe(await loaderId("p", "a"));
  });

  it("runs a hook in name order, and stops at the first failure", async () => {
    const orgId = org();
    const it0 = await item(orgId);
    const comment = (text: string) =>
      `export default { on: { async entered(ctx) { await ctx.comment(${JSON.stringify(text)}); } } };`;
    for (const [name, code] of [
      ["a-first", comment("first")],
      ["b-fails", "export default { on: { entered() { throw new Error('nope'); } } };"],
      ["c-never", comment("never")],
    ] as const) {
      const saved = await savePluginChecked(env, {
        orgId,
        name,
        request: "",
        code,
        createdBy: "u",
      });
      expect(saved.ok).toBe(true);
    }
    const out = await dispatch(
      env,
      orgId,
      "entered",
      { item: it0, from: null, to: "a" },
      { item: it0 },
    );
    expect(out.failure).toEqual({ plugin: "b-fails", message: 'Plugin "b-fails" failed: nope' });
    expect(out.stopped).toMatchObject({ error: 'Plugin "b-fails" failed: nope' });
    expect((await getPlugin(env.DB, orgId, "b-fails"))?.lastError).toBe(
      'Plugin "b-fails" failed: nope',
    );
    const { results } = await env.DB.prepare(
      "SELECT data FROM flow_events WHERE item_id = ? AND kind = 'comment'",
    )
      .bind(it0.id)
      .all<{ data: string }>();
    expect(results.map((r) => JSON.parse(r.data).text)).toEqual(["first"]);
  });

  it("gives up on work past its deadline", async () => {
    await expect(withDeadline(() => new Promise(() => {}), 20)).rejects.toThrow(/longer than/);
  });
});
