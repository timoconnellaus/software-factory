// The flow contract against the real engine: a small org seeded through the real routes (a
// workflow, projects, agents, an item moved through a run with events, a comment, a plugin's card
// and field, a gateway, a schedule, a chat with a did row), then every operation the desktop app
// calls, with inputs built the way the app builds them (packages/client/src/flow-contract.ts), each
// answer checked against the schema the app's types are inferred from. And every key the app's
// types describe was sent by the server at least once, unless EXPECTED_UNSEEN says why not.
import { env } from "cloudflare:workers";
import { buildTimeline, type FlowTimeline, type FlowWorkflow } from "@software-factory/client/flow";
import { chatTurns, type FlowChatView } from "@software-factory/client/flow-chat";
import {
  type ContractIds,
  FLOW_OP_NAMES,
  FLOW_REQUESTS,
  FLOW_RESPONSES,
  type FlowOpName,
  unseenKeys,
} from "@software-factory/client/flow-contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { base, claim, type Person, person, post } from "./flow-helpers.ts";
import { uid } from "./helpers.ts";

/**
 * Keys the app's types describe that this org's answers leave out, and why. Anything else unseen
 * is a field the app reads that the server never sends.
 */
const EXPECTED_UNSEEN: Partial<Record<FlowOpName, string[]>> = {
  // Only flow.project.list counts open items; create and setWorkflow answer the project alone.
  "flow.project.create": ["openCount"],
  "flow.project.setWorkflow": ["openCount"],
};

/** One call through the door, as the app sends it: the result, or the refusal thrown. */
async function send(p: Person, op: string, input: unknown): Promise<unknown> {
  const res = await post("call", { op, input }, p.token);
  const body = (await res.json()) as { result?: unknown; error?: string; code?: string };
  if (res.status !== 200) {
    throw new Error(`${op} ${JSON.stringify(input)}: ${res.status} ${body.code} ${body.error}`);
  }
  return body.result;
}

let rpcId = 0;
/** A tool call on the engine's MCP server, with a chat run's token: what the agent did. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request(`${base}/flow/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      headers: { "content-type": "application/json", authorization: token },
    }),
    env,
  );
  const body = (await res.json()) as { result: { isError?: boolean } };
  if (body.result.isError) throw new Error(`${name} failed`);
}

const PLUGIN = `export default {
  fields: [{ id: "customer", label: "Customer", type: "text" }],
  on: {
    async entered(ctx, { to, item }) {
      if (to !== "review") return;
      await ctx.setField("customer", "Acme " + item.number);
      await ctx.card({
        kind: "summary",
        title: "Ready for review",
        subtitle: "From the draft",
        rows: [{ label: "Words", value: "150" }],
        checks: [{ label: "Spelling", ok: true }],
        bars: [{ label: "Length", value: 150, max: 200 }],
        link: { label: "Preview", url: "https://example.com/preview" },
      });
    },
    async trigger() {},
  },
};`;

describe("the desktop app's flow contract against the engine", () => {
  it("answers every operation the app calls in the shape the app reads", async () => {
    const p = await person();
    const answers = new Map<FlowOpName, unknown[]>();
    const ids: ContractIds = {
      orgId: p.orgId,
      userId: p.userId,
      projectId: "",
      workflowId: "",
      agentId: "",
      builderId: "",
      itemId: "",
      runId: "",
      chatId: "",
      pluginName: "cards",
      gatewayName: "blog",
      gatewayId: "",
      scheduleId: "",
    };

    /**
     * Each input the app builds for `op` (or just the `only`th) through the door, each answer parsed
     * by the app's schema. Answers the last.
     */
    async function check<N extends FlowOpName>(
      op: N,
      over: Partial<ContractIds> = {},
      only?: number,
    ): Promise<Record<string, unknown>> {
      const inputs = FLOW_REQUESTS[op]({ ...ids, ...over });
      let last: unknown;
      for (const [i, input] of inputs.entries()) {
        if (only !== undefined && i !== only) continue;
        last = await send(p, op, input);
        const parsed = FLOW_RESPONSES[op].safeParse(last);
        expect(
          parsed.success ? [] : parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
          `${op} answered ${JSON.stringify(last)}`,
        ).toEqual([]);
        answers.set(op, [...(answers.get(op) ?? []), last]);
      }
      return last as Record<string, unknown>;
    }

    // Another member, who signed in without GitHub: no login.
    const other = uid("usr_");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'Mia', ?, NULL, ?, ?)",
      ).bind(other, `${other}@example.com`, now, now),
      env.DB.prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      ).bind(uid("mem_"), p.orgId, other, now),
    ]);

    // The org's agents: Chat's Builder, and a writer (made, then changed as Team changes it).
    ids.builderId = String((await check("flow.agent.ensureBuilder")).id);
    ids.agentId = String((await check("flow.agent.create")).id);
    await check("flow.agent.update");

    // A workflow as the editor saves it, and a project on it.
    ids.workflowId = String((await check("flow.workflow.create")).id);
    ids.projectId = String((await check("flow.project.create")).id);
    await check("flow.project.setWorkflow");
    await check("flow.workflow.update");

    // The seeded work: Draft (the writer; leaving it takes a decision) → Review (the person) →
    // Done, with a plugin that adds a field and a card on entering Review.
    const seed = (await send(p, "flow.workflow.create", {
      orgId: p.orgId,
      name: "Seed",
      statuses: [
        {
          id: "draft",
          name: "Draft",
          owner: { kind: "agent", agentId: ids.agentId },
          brief: "Draft it.",
          needsDecision: true,
          onDone: "review",
        },
        {
          id: "review",
          name: "Review",
          owner: { kind: "person", userId: p.userId },
          onReject: "draft",
        },
        { id: "done", name: "Done", owner: { kind: "none" } },
      ],
    })) as { id: string };
    const project = (await send(p, "flow.project.create", {
      orgId: p.orgId,
      name: "Blog",
      key: "BLG",
      workflowId: seed.id,
    })) as { id: string };
    await send(p, "flow.plugin.save", {
      orgId: p.orgId,
      name: ids.pluginName,
      request: "Show the customer and a summary card.",
      code: PLUGIN,
    });
    ids.projectId = project.id;
    const item = String((await check("flow.item.create")).id);
    ids.itemId = item;
    await check("flow.item.comment");

    // Its run: claimed, a note, a tool call and its result, then handed back done.
    const job = await claim(p);
    if (!job || job.workItem.id !== item) throw new Error("no job for the item");
    ids.runId = job.jobId;
    let seq = 0;
    const ev = (e: Record<string, unknown>) => ({
      jobId: job.jobId,
      seq: ++seq,
      at: new Date(Date.UTC(2026, 10, 15, 10, 0, seq)).toISOString(),
      ...e,
    });
    await p.channel.events(job.jobId, {
      fencingToken: job.lease.fencingToken,
      events: [
        ev({ type: "message", role: "assistant", text: "Drafting it now." }),
        ev({ type: "tool", name: "Write", input: '{"file_path":"post.md"}', id: "tu_1" }),
        ev({ type: "tool.result", toolId: "tu_1", output: "Wrote post.md", isError: false }),
        ev({
          type: "turn",
          outcome: "success",
          usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ] as Parameters<typeof p.channel.events>[1]["events"],
    });
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Drafted the post: 150 words." },
    });
    await p.channel.release({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      finalState: "handed_back",
    });

    // Waiting on a decision: the inbox, then Approve, then the person's Done.
    await check("flow.inbox.get");
    await check("flow.inbox.all");
    expect((await check("flow.item.decide")).statusId).toBe("review");
    await check("flow.item.get");
    await check("flow.board.get");
    await check("flow.inbox.get");
    await check("flow.inbox.all");
    await check("flow.workflow.get", { workflowId: seed.id });
    expect((await check("flow.item.finish")).statusId).toBe("done");
    // The timeline's entries hold what the kernel and plugins wrote (`data` is unknown to the
    // schema): the item panel tells them as the app's own logic reads them.
    const timeline = (await check("flow.timeline.get")) as unknown as FlowTimeline;
    const statuses = (
      (await send(p, "flow.workflow.get", { orgId: p.orgId, workflowId: seed.id })) as FlowWorkflow
    ).workflow.statuses;
    const names = {
      me: { id: p.userId, name: "Sam" },
      agents: [{ id: ids.agentId, name: "Writer" }],
    };
    const told = buildTimeline(timeline.entries, statuses, names).map((r) =>
      r.type === "line"
        ? [r.who, r.what, r.after]
        : [r.who, r.by, r.text, r.cards.map((c) => c.title), r.runId === ids.runId],
    );
    expect(told).toEqual([
      ["Sam", "created this item", "Handed to Writer, who started a run"],
      ["Sam", "person", "Mention the board.", [], false],
      ["Writer", "agent", "Drafted the post: 150 words.", [], true],
      ["Writer", "finished", "Waiting on a decision"],
      ["Sam", "approved it from Draft to Review", "Waiting on you"],
      ["cards", "plugin", null, ["Ready for review"], false],
      ["Sam", "moved it from Review to Done", null],
    ]);
    await check("flow.inbox.get");
    await check("flow.run.list");
    await check("flow.run.get");
    await check("flow.run.events");

    // A second item whose run hands back nothing valid: stopped, then retried.
    const stopped = String((await check("flow.item.create")).id);
    const failed = await claim(p);
    if (!failed) throw new Error("no job for the second item");
    await p.channel.handback({
      jobId: failed.jobId,
      fencingToken: failed.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
    });
    await check("flow.inbox.all");
    await check("flow.item.retry", { itemId: stopped });
    await check("flow.inbox.all");
    // Its new run is claimed and left running.
    if ((await claim(p))?.workItem.id !== stopped) throw new Error("no retried run");

    // Chat: the Builder's run creates a workflow (a did row) and answers.
    ids.chatId = String(((await check("flow.chat.create")).chat as { id: string }).id);
    const chatJob = await claim(p);
    if (!chatJob) throw new Error("no job for the chat");
    const token = chatJob.mcpServers?.[0]?.headers?.Authorization ?? "";
    await tool(token, "flow_call", {
      op: "flow.workflow.create",
      input: {
        name: "Launch content",
        statuses: [
          { id: "brief", name: "Brief", owner: { kind: "person", userId: p.userId } },
          { id: "edit", name: "Edit", owner: { kind: "none" } },
        ],
      },
    });
    await p.channel.handback({
      jobId: chatJob.jobId,
      fencingToken: chatJob.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Done: Launch content has Brief and Edit." },
    });
    const chat = (await check("flow.chat.get")) as unknown as FlowChatView;
    expect(chatTurns(chat.messages, chat.working)).toMatchObject([
      { kind: "person", text: "Set up a workflow for launch posts." },
      {
        kind: "agent",
        text: "Done: Launch content has Brief and Edit.",
        dids: [{ text: "Created the workflow Launch content (2 statuses)" }],
        working: false,
      },
    ]);
    await check("flow.chat.list");
    await check("flow.run.list", { agentId: ids.builderId });
    await check("flow.run.get", { runId: chatJob.jobId });
    await check("flow.chat.send");

    // Plugins and gateways: the plugin's list and detail, off and on; a gateway made, then edited.
    await check("flow.plugin.list");
    await check("flow.plugin.get");
    await check("flow.plugin.setEnabled");
    ids.gatewayId = String((await check("flow.gateway.save", {}, 0)).id);
    await check("flow.gateway.save", {}, 1);
    await check("flow.gateway.list");

    // Auto: a daily, hourly and weekly schedule, one switched off, one run now.
    ids.scheduleId = String((await check("flow.schedule.save", {}, 0)).id);
    await check("flow.schedule.save", {}, 1);
    await check("flow.schedule.save", {}, 2);
    await check("flow.schedule.save", {}, 3);
    await check("flow.schedule.runNow");
    await check("flow.schedule.list");

    // The plain reads, over everything above.
    await check("flow.project.list");
    await check("flow.workflow.list");
    await check("flow.workflow.get");
    await check("flow.agent.list");
    await check("flow.member.list");

    // And the deletes, last.
    await check("flow.schedule.delete");
    await check("flow.gateway.delete");
    await check("flow.plugin.delete");
    await check("flow.chat.delete");

    // Every operation the app calls was called.
    expect(FLOW_OP_NAMES.filter((op) => !answers.has(op))).toEqual([]);
    // And every optional key the app's types describe was sent by the server, or is expected not
    // to be.
    const unseen: Record<string, string[]> = {};
    for (const op of FLOW_OP_NAMES) {
      const keys = unseenKeys(FLOW_RESPONSES[op], answers.get(op) ?? []).filter(
        (k) => !EXPECTED_UNSEEN[op]?.includes(k),
      );
      if (keys.length) unseen[op] = keys;
    }
    expect(unseen).toEqual({});
  });
});
