// Milestone 2 of the new core through the engine's real routes (spec 70): plugins run as real
// Dynamic Workers (the Worker Loader binding in wrangler.jsonc, served by workerd under
// @cloudflare/vitest-plugin), their hooks around every item event, gateways, triggers, and the
// engine's MCP server.
import { env } from "cloudflare:workers";
import { jobSchema } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { base, claim, type Person, person, post } from "./flow-helpers.ts";
import { first } from "./helpers.ts";

type Item = {
  id: string;
  statusId: string;
  error: string | null;
  fields: Record<string, unknown>;
  waiting: { on: string };
};
type Entry = { kind: string; actor: { kind: string; id?: string }; data: Record<string, unknown> };

afterEach(() => vi.restoreAllMocks());

/** Write (the person) → Published (nobody) → Archived (nobody), a project on it, and an item. */
async function publishing(p: Person, body = "Some text.") {
  const workflow = await p.call<{ id: string }>("flow.workflow.create", {
    name: "Publish",
    statuses: [
      { id: "write", name: "Write", owner: { kind: "person", userId: p.userId } },
      { id: "published", name: "Published", owner: { kind: "none" } },
      { id: "archived", name: "Archived", owner: { kind: "none" } },
    ],
  });
  const project = await p.call<{ id: string }>("flow.project.create", {
    name: "Blog",
    key: "BLG",
    workflowId: workflow.id,
  });
  const item = await p.call<Item>("flow.item.create", {
    projectId: project.id,
    title: "Launch post",
    body,
  });
  return { project, item };
}

const save = (p: Person, name: string, code: string) =>
  p.call<{ id: string; triggerPath: string; hooks: string[] }>("flow.plugin.save", {
    name,
    request: `The ${name} plugin.`,
    code,
  });

/** A call through the door that is expected to be refused: its status and body. */
async function refused(p: Person, op: string, input: Record<string, unknown>) {
  const res = await post("call", { op, input: { orgId: p.orgId, ...input } }, p.token);
  return { status: res.status, body: (await res.json()) as { code: string; error: string } };
}

const timeline = async (p: Person, itemId: string) =>
  (await p.call<{ entries: Entry[] }>("flow.timeline.get", { itemId })).entries;

const CARDS = `export default {
  fields: [{ id: "customer", label: "Customer", type: "text" }],
  on: {
    async entered(ctx, { to, item }) {
      if (to !== "published") return;
      await ctx.setField("customer", "Acme " + item.number);
      await ctx.card({
        kind: "summary",
        title: "Published",
        rows: [{ label: "Words", value: String(item.body.split(" ").length) }],
        checks: [{ label: "Spelling", ok: true }],
      });
    },
  },
};`;

describe("plugins on the new core", () => {
  it("runs an entered hook that adds a card and sets a field, and declares its field", async () => {
    const p = await person();
    const { project, item } = await publishing(p);
    const saved = await save(p, "cards", CARDS);
    expect(saved.hooks).toEqual(["entered"]);
    const moved = await p.call<Item>("flow.item.move", { itemId: item.id, to: "published" });
    expect(moved).toMatchObject({
      statusId: "published",
      error: null,
      fields: { customer: "Acme 1" },
    });
    const card = (await timeline(p, item.id)).find((e) => e.kind === "card");
    expect(card).toMatchObject({
      actor: { kind: "plugin", id: "cards" },
      data: { kind: "summary", title: "Published", checks: [{ label: "Spelling", ok: true }] },
    });
    const board = await p.call<{ declaredFields: unknown[]; columns: { items: Item[] }[] }>(
      "flow.board.get",
      { projectId: project.id },
    );
    expect(board.declaredFields).toEqual([{ id: "customer", label: "Customer", type: "text" }]);
    expect(board.columns[1]?.items[0]?.fields).toEqual({ customer: "Acme 1" });
    const got = await p.call<{ declaredFields: unknown[] }>("flow.item.get", { itemId: item.id });
    expect(got.declaredFields).toHaveLength(1);
    // A person sets a field by hand.
    const set = await p.call<Item>("flow.item.setField", {
      itemId: item.id,
      fieldId: "customer",
      value: "Globex",
    });
    expect(set.fields).toEqual({ customer: "Globex" });
  });

  it("lets a leaving hook refuse a move, with its reason", async () => {
    const p = await person();
    const { item } = await publishing(p, "  ");
    await save(
      p,
      "needs-text",
      `export default { on: { leaving(ctx, { from, item }) {
        if (from === "write" && !item.body.trim()) return { refuse: "The post has no text yet." };
      } } };`,
    );
    const out = await refused(p, "flow.item.move", { itemId: item.id, to: "published" });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ code: "conflict" });
    expect(out.body.error).toContain("The post has no text yet.");
    expect((await p.call<Item>("flow.item.get", { itemId: item.id })).statusId).toBe("write");
  });

  it("stops the item when a plugin throws, and a retry succeeds once it is fixed", async () => {
    const p = await person();
    const { item } = await publishing(p);
    const broken = `export default { on: { entered(ctx, { to }) {
      if (to === "published") throw new Error("the blog is down");
    } } };`;
    await save(p, "poster", broken);
    const stopped = await p.call<Item>("flow.item.move", { itemId: item.id, to: "published" });
    expect(stopped).toMatchObject({
      statusId: "published",
      error: 'Plugin "poster" failed: the blog is down',
      waiting: { on: "nothing" },
    });
    const list = await p.call<{ plugins: { name: string; lastError: string | null }[] }>(
      "flow.plugin.list",
      {},
    );
    expect(list.plugins[0]?.lastError).toBe('Plugin "poster" failed: the blog is down');
    // Fixed: saved again (a new worker), live at once; the retry runs `entered` again.
    await save(
      p,
      "poster",
      `export default { on: { async entered(ctx, { to }) {
        if (to === "published") await ctx.comment("Posted.");
      } } };`,
    );
    const retried = await p.call<Item>("flow.item.retry", { itemId: item.id });
    expect(retried).toMatchObject({ statusId: "published", error: null });
    const said = (await timeline(p, item.id)).filter((e) => e.kind === "comment");
    expect(said.map((e) => e.data.text)).toEqual(["Posted."]);
    const after = await p.call<{ plugins: { lastError: string | null }[] }>("flow.plugin.list", {});
    expect(after.plugins[0]?.lastError).toBeNull();
  });

  it("refuses to save code that doesn't load or has the wrong shape", async () => {
    const p = await person();
    const syntax = await refused(p, "flow.plugin.save", { name: "x", code: "export default {{" });
    expect(syntax.status).toBe(400);
    expect(syntax.body.error).toMatch(/didn't load/);
    const shape = await refused(p, "flow.plugin.save", {
      name: "x",
      code: "export default { on: { entred() {} } };",
    });
    expect(shape.body.error).toContain("on.entred isn't a hook");
    expect((await p.call<{ plugins: unknown[] }>("flow.plugin.list", {})).plugins).toEqual([]);
  });

  it("calls a gateway with its credential, and the plugin can't reach the network itself", async () => {
    const p = await person();
    const { item } = await publishing(p);
    await p.call("flow.gateway.save", {
      name: "blog",
      baseUrl: "https://upstream.test/api",
      auth: { kind: "bearer" },
      secret: "blog-token",
    });
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      return Response.json({ url: "https://blog.test/launch-post" }, { status: 201 });
    });
    await save(
      p,
      "blog",
      `export default { on: { async entered(ctx, { to, item }) {
        if (to !== "published") return;
        let direct = "reached";
        try { await fetch("https://example.com/"); } catch (e) { direct = e.message; }
        await ctx.comment("direct: " + direct);
        const res = await ctx.gateway("blog").fetch("/posts?draft=0", { method: "POST", body: { title: item.title } });
        await ctx.setField("postUrl", (await res.json()).url + " " + res.status);
        const missing = await ctx.gateway("nope").fetch("/x").then(() => "ok", (e) => e.message);
        await ctx.comment("missing: " + missing);
        const escape = await ctx.gateway("blog").fetch("../../admin").then(() => "ok", (e) => e.message);
        await ctx.comment("escape: " + escape);
      } } };`,
    );
    const moved = await p.call<Item>("flow.item.move", { itemId: item.id, to: "published" });
    expect(moved.error).toBeNull();
    expect(moved.fields).toEqual({ postUrl: "https://blog.test/launch-post 201" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        url: "https://upstream.test/api/posts?draft=0",
        auth: "Bearer blog-token",
        body: JSON.stringify({ title: "Launch post" }),
      },
    ]);
    const said = (await timeline(p, item.id))
      .filter((e) => e.kind === "comment")
      .map((e) => String(e.data.text));
    expect(said[0]).toMatch(/^direct: .*not permitted to access the internet/);
    expect(said[1]).toBe('missing: There is no gateway "nope" in this org.');
    expect(said[2]).toMatch(/^escape: .*leaves the gateway's base URL/);
    // No read returns the secret.
    const listed = await p.call<{ gateways: Record<string, unknown>[] }>("flow.gateway.list", {});
    expect(JSON.stringify(listed)).not.toContain("blog-token");
    expect(listed.gateways[0]).toMatchObject({ name: "blog", hasSecret: true });
  });

  it("creates an item from a trigger with the right key, and refuses a wrong key", async () => {
    const p = await person();
    const { project } = await publishing(p);
    const plugin = await save(
      p,
      "support-email",
      `export default {
        fields: [{ id: "customer", label: "Customer", type: "text" }],
        on: { async trigger(ctx, { name, payload }) {
          await ctx.createItem({ projectId: payload.projectId, title: name + ": " + payload.subject, body: payload.text, fields: { customer: payload.from } });
        } },
      };`,
    );
    // The list gives the trigger's path (with its key) to members, for Auto's Triggers tab; a plugin
    // with no trigger has none.
    await save(p, "quiet", "export default { on: { async entered() {} } };");
    const listed = await p.call<{ plugins: { name: string; triggerPath?: string }[] }>(
      "flow.plugin.list",
      {},
    );
    expect(listed.plugins.find((x) => x.name === "support-email")?.triggerPath).toBe(
      plugin.triggerPath,
    );
    expect(listed.plugins.find((x) => x.name === "quiet")).not.toHaveProperty("triggerPath");
    const path = plugin.triggerPath.replace("<name>", "email");
    const fire = (url: string, body: unknown) =>
      worker.fetch(
        new Request(`${base}${url}`, { method: "POST", body: JSON.stringify(body) }),
        env,
      );
    const payload = { projectId: project.id, subject: "Help", text: "It broke.", from: "Acme" };
    const wrong = await fire(path.replace(/key=[^&]+/, "key=nope"), payload);
    expect(wrong.status).toBe(403);
    const res = await fire(path, payload);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { created: { id: string; title: string; fields: unknown }[] };
    expect(out.created).toMatchObject([{ title: "email: Help", fields: { customer: "Acme" } }]);
    // The item belongs to the person who saved the plugin, in their inbox (Write is theirs).
    const inbox = await p.call<{ work: { id: string }[] }>("flow.inbox.get", {});
    expect(inbox.work.map((i) => i.id)).toContain(out.created[0]?.id);
    const big = await fire(path, { ...payload, text: "x".repeat(300 * 1024) });
    expect(big.status).toBe(413);
  });

  it("stops an item that plugins keep moving, after 10 moves", async () => {
    const p = await person();
    const { item } = await publishing(p);
    await save(
      p,
      "ping-pong",
      `export default { on: { async entered(ctx, { to }) {
        if (to === "published") await ctx.move("archived");
        if (to === "archived") await ctx.move("published");
      } } };`,
    );
    const moved = await p.call<Item>("flow.item.move", { itemId: item.id, to: "published" });
    expect(moved.error).toMatch(/more than 10 times/);
  });
});

/** Draft (an agent that may have the factory MCP server) → Done (nobody), and an item. */
async function agentStatus(p: Person, mcp: string[]) {
  const agent = await p.call<{ id: string }>("flow.agent.create", {
    name: "Builder",
    instructions: "You build workflows and plugins.",
    mcp,
  });
  const workflow = await p.call<{ id: string }>("flow.workflow.create", {
    name: "Draft, done",
    statuses: [
      { id: "draft", name: "Draft", owner: { kind: "agent", agentId: agent.id }, brief: "Go." },
      { id: "done", name: "Done", owner: { kind: "none" } },
    ],
  });
  const project = await p.call<{ id: string }>("flow.project.create", {
    name: "Ops",
    key: "OPS",
    workflowId: workflow.id,
  });
  const item = await p.call<Item>("flow.item.create", { projectId: project.id, title: "Set up" });
  return { agent, project, item };
}

const mcp = (token: string | undefined, body: unknown) =>
  worker.fetch(
    new Request(`${base}/flow/mcp`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: token } : {}),
      },
    }),
    env,
  );

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp(token, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await res.json()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { text: body.result.content[0]?.text ?? "", isError: body.result.isError === true };
}

describe("the engine's MCP server", () => {
  it("serves a claimed run's agent, saves only plugins that load, and refuses a finished run", async () => {
    const p = await person();
    const { item } = await agentStatus(p, ["factory"]);
    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(jobSchema.safeParse(job).success).toBe(true);
    const server = job.mcpServers?.[0];
    expect(server).toMatchObject({ name: "factory", url: `${base}/flow/mcp` });
    const token = server?.headers?.Authorization ?? "";
    expect(token).toMatch(/^Bearer frun_/);
    // Only the hash is stored.
    const row = await first<{ mcp_token_hash: string }>(
      "SELECT mcp_token_hash FROM flow_runs WHERE id = ?",
      job.jobId,
    );
    expect(row?.mcp_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(row?.mcp_token_hash ?? "-");

    const init = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(await init.json()).toMatchObject({
      result: { serverInfo: { name: "software-factory" } },
    });
    const listed = (await (
      await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).toEqual([
      "flow_ops",
      "flow_call",
      "plugin_guide",
      "plugin_list",
      "plugin_read",
      "plugin_save",
      "plugin_delete",
      "gateway_list",
    ]);
    expect((await tool(token, "plugin_guide")).text).toContain("export default");
    expect((await tool(token, "flow_ops")).text).toContain("flow.plugin.save");

    // plugin_save refuses code that doesn't load, and saves code that does.
    const bad = await tool(token, "plugin_save", { name: "notes", code: "export default (" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/didn't load/);
    const good = await tool(token, "plugin_save", {
      name: "notes",
      request: "Note when an item is done.",
      code: `export default { on: { async entered(ctx, { to }) { if (to === "done") await ctx.comment("Done!"); } } };`,
    });
    expect(good.isError).toBe(false);
    expect(JSON.parse(good.text)).toMatchObject({ name: "notes", createdBy: p.userId });
    expect((await tool(token, "plugin_read", { name: "notes" })).text).toContain("Done!");
    // flow_call acts in the run's org, as its agent.
    const projects = await tool(token, "flow_call", { op: "flow.project.list", input: {} });
    expect(JSON.parse(projects.text).projects).toHaveLength(1);
    const elsewhere = await tool(token, "flow_call", {
      op: "flow.project.list",
      input: { orgId: "org_other" },
    });
    expect(JSON.parse(elsewhere.text).projects).toHaveLength(1);

    // The run hands back: its `done` enters Done, where the new plugin comments.
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Set up." },
    });
    const done = await p.call<Item>("flow.item.get", { itemId: item.id });
    expect(done.statusId).toBe("done");
    const said = (await timeline(p, item.id)).filter((e) => e.kind === "comment");
    expect(said.map((e) => e.data.text)).toContain("Done!");

    // The run is over: its token is refused.
    const after = await mcp(token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(after.status).toBe(401);
    expect((await mcp(undefined, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status).toBe(
      401,
    );
  });

  it("gives no MCP server to an agent without it, and stops the item when leaving refuses a hand-back", async () => {
    const p = await person();
    const { item } = await agentStatus(p, []);
    await save(
      p,
      "gate",
      `export default { on: { leaving(ctx, { from }) { if (from === "draft") return { refuse: "Not yet." }; } } };`,
    );
    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(job.mcpServers).toBeUndefined();
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Drafted." },
    });
    const stopped = await p.call<Item>("flow.item.get", { itemId: item.id });
    expect(stopped).toMatchObject({ statusId: "draft", error: 'Plugin "gate" refused: Not yet.' });
    const runs = await p.call<{ runs: { status: string }[] }>("flow.run.list", { itemId: item.id });
    expect(runs.runs.map((r) => r.status)).toEqual(["done"]);
  });
});
