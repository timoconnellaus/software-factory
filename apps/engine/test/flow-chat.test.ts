// Chat on the new core (migration 0433) through the engine's real routes: a person's message queues
// one run of the chat's agent, a runner claims it as a flow job with no repository and the factory
// MCP server, what the agent changes through that server becomes `did` rows, and the hand-back's
// summary becomes the agent's reply.
import { env } from "cloudflare:workers";
import { jobSchema } from "@software-factory/runner-contract";
import { expireRuns } from "@software-factory/store";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { base, claim, type Person, person, post } from "./flow-helpers.ts";

type Message = { seq: number; role: string; text: string; data: unknown; runId: string | null };
type ChatView = {
  chat: { id: string; title: string; agentId: string };
  messages: Message[];
  working: boolean;
  made: { workflows: { id: string; name: string }[]; plugins: { id: string; name: string }[] };
};

const mcp = (token: string, body: unknown) =>
  worker.fetch(
    new Request(`${base}/flow/mcp`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: token },
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

async function refused(p: Person, op: string, input: Record<string, unknown>, token = p.token) {
  const res = await post("call", { op, input }, token);
  return { status: res.status, body: (await res.json()) as { code: string; error: string } };
}

const handback = (
  p: Person,
  job: { jobId: string; lease: { fencingToken: number } },
  summary: string,
) =>
  p.channel.handback({
    jobId: job.jobId,
    fencingToken: job.lease.fencingToken,
    outcome: "completed",
    artifactIds: [],
    branch: "",
    result: { outcome: "done", summary },
  });

describe("Chat", () => {
  it("runs a message as one run, records what the agent did, and makes its summary the reply", async () => {
    const p = await person();
    // A fresh org: ensureBuilder creates the Builder with the factory server, then finds it again.
    const builder = await p.call<{ id: string; name: string; mcp: string[] }>(
      "flow.agent.ensureBuilder",
      {},
    );
    expect(builder).toMatchObject({ name: "Builder", mcp: ["factory"] });
    expect((await p.call<{ id: string }>("flow.agent.ensureBuilder", {})).id).toBe(builder.id);

    const text =
      "Set up a workflow for launch content: I write a brief, an agent drafts it, then I edit it.";
    const started = await p.call<ChatView>("flow.chat.create", { agentId: builder.id, text });
    expect(started.working).toBe(true);
    expect(started.chat.title).toBe(`${text.slice(0, 79).trimEnd()}…`);
    expect(started.messages.map((m) => m.role)).toEqual(["person"]);
    const chatId = started.chat.id;

    // Sending while the run is queued is refused, plainly.
    const busy = await refused(p, "flow.chat.send", { orgId: p.orgId, chatId, text: "And?" });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/still answering/);

    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(jobSchema.safeParse(job).success).toBe(true);
    expect(job.stage).toBe("flow");
    expect(job.repo).toBeUndefined();
    expect(job.context).toMatchObject({ orgId: p.orgId, chatId });
    expect(job.harness.prompt).toContain(text);
    expect(job.harness.prompt).toContain("flow_ops");
    expect(job.mcpServers?.[0]).toMatchObject({ name: "factory", url: `${base}/flow/mcp` });
    const token = job.mcpServers?.[0]?.headers?.Authorization ?? "";

    // Still in flight once claimed.
    expect(
      (await refused(p, "flow.chat.send", { orgId: p.orgId, chatId, text: "And?" })).status,
    ).toBe(409);

    // The agent (this test, with the run's token) reads, then creates a workflow.
    expect((await tool(token, "flow_call", { op: "flow.workflow.list", input: {} })).isError).toBe(
      false,
    );
    const created = await tool(token, "flow_call", {
      op: "flow.workflow.create",
      input: {
        name: "Launch content",
        statuses: [
          { id: "brief", name: "Brief", owner: { kind: "person", userId: p.userId } },
          { id: "draft", name: "Draft", owner: { kind: "agent", agentId: builder.id } },
          { id: "edit", name: "Edit", owner: { kind: "person", userId: p.userId } },
        ],
      },
    });
    expect(created.isError).toBe(false);
    const workflowId = (JSON.parse(created.text) as { id: string }).id;
    // A refused call writes nothing.
    expect(
      (await tool(token, "flow_call", { op: "flow.workflow.create", input: { name: "x" } }))
        .isError,
    ).toBe(true);

    const during = await p.call<ChatView>("flow.chat.get", { chatId });
    expect(during.working).toBe(true);
    expect(during.messages.map((m) => [m.role, m.text])).toEqual([
      ["person", text],
      ["did", "Created the workflow Launch content (3 statuses)"],
    ]);
    expect(during.messages[1]?.data).toEqual({
      kind: "workflow",
      id: workflowId,
      name: "Launch content",
    });

    await handback(p, job, "Done. Launch content has Brief, Draft and Edit.");
    const after = await p.call<ChatView>("flow.chat.get", { chatId });
    expect(after.working).toBe(false);
    expect(after.messages.map((m) => m.role)).toEqual(["person", "did", "agent"]);
    expect(after.messages[2]).toMatchObject({
      text: "Done. Launch content has Brief, Draft and Edit.",
      runId: job.jobId,
    });
    expect(after.made.workflows).toEqual([{ id: workflowId, name: "Launch content" }]);
    expect(after.made.plugins).toEqual([]);

    // The run is a chat's: flow.run.list by agent names the chat, not an item.
    const runs = await p.call<{ runs: { chatId: string; chatTitle: string; itemId: null }[] }>(
      "flow.run.list",
      { agentId: builder.id },
    );
    expect(runs.runs[0]).toMatchObject({ chatId, itemId: null, chatTitle: started.chat.title });

    // The next message: its prompt carries the conversation so far.
    await p.call<ChatView>("flow.chat.send", { chatId, text: "Add a Published status." });
    const next = await claim(p);
    expect(next?.harness.prompt).toContain("Created the workflow Launch content");
    expect(next?.harness.prompt).toContain("Add a Published status.");
    const list = await p.call<{ chats: { id: string }[] }>("flow.chat.list", {});
    expect(list.chats.map((c) => c.id)).toEqual([chatId]);
  });

  it("leaves a plain agent message when a run fails or its lease lapses, and the person can send again", async () => {
    const p = await person();
    const builder = await p.call<{ id: string }>("flow.agent.ensureBuilder", {});
    const { chat } = await p.call<ChatView>("flow.chat.create", {
      agentId: builder.id,
      text: "Build a plugin.",
    });
    const job = await claim(p);
    if (!job) throw new Error("no job");
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "failed",
      artifactIds: [],
      branch: "",
      summary: "Claude stopped: the session timed out",
    });
    const failed = await p.call<ChatView>("flow.chat.get", { chatId: chat.id });
    expect(failed.working).toBe(false);
    expect(failed.messages.at(-1)).toMatchObject({
      role: "agent",
      text: "I couldn't finish that: Claude stopped: the session timed out. Send your message again to have me try once more.",
      data: { failed: true },
    });

    // Sending again works, and the sweep fails a run whose runner went quiet.
    await p.call("flow.chat.send", { chatId: chat.id, text: "Build a plugin." });
    expect(await claim(p)).toBeTruthy();
    expect(await expireRuns(env.DB, Date.now() + 11 * 60_000, 10)).toBeGreaterThanOrEqual(1);
    const lapsed = await p.call<ChatView>("flow.chat.get", { chatId: chat.id });
    expect(lapsed.messages.at(-1)?.text).toMatch(/^I couldn't finish that: The runner stopped/);
    expect(lapsed.working).toBe(false);

    // Deleting it removes it from the list.
    await p.call("flow.chat.delete", { chatId: chat.id });
    expect((await p.call<{ chats: unknown[] }>("flow.chat.list", {})).chats).toEqual([]);
  });

  it("refuses an agent without the factory server, and another org's member", async () => {
    const p = await person();
    const plain = await p.call<{ id: string }>("flow.agent.create", {
      name: "Writer",
      instructions: "Write.",
    });
    const no = await refused(p, "flow.chat.create", {
      orgId: p.orgId,
      agentId: plain.id,
      text: "Hello",
    });
    expect(no.status).toBe(400);
    expect(no.body.error).toContain('Turn on "Plugin editor" for Writer in Team');

    const builder = await p.call<{ id: string }>("flow.agent.ensureBuilder", {});
    const { chat } = await p.call<ChatView>("flow.chat.create", {
      agentId: builder.id,
      text: "Hello",
    });
    const other = await person();
    const theirs = await refused(
      other,
      "flow.chat.get",
      { orgId: p.orgId, chatId: chat.id },
      other.token,
    );
    expect(theirs.status).toBe(403);
    const named = await refused(
      other,
      "flow.chat.get",
      { orgId: other.orgId, chatId: chat.id },
      other.token,
    );
    expect(named.status).toBe(404);
  });
});
