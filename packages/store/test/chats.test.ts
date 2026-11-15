import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  addDid,
  chatHistory,
  chatTitle,
  createAgent,
  createChat,
  deleteChat,
  getChat,
  madeOf,
  StoreError,
  sendMessage,
} from "../src/index.ts";

const d1 = env.DB;

describe("chats", () => {
  it("titles a chat by its first message, cut to 80 characters", () => {
    expect(chatTitle("  Set up\n a workflow  ")).toBe("Set up a workflow");
    const long = chatTitle("x".repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("lists each workflow and plugin made once, by its latest name, and drops a deleted one", () => {
    expect(
      madeOf([
        { kind: "workflow", id: "w1", name: "Launch" },
        { kind: "agent", id: "a1", name: "Research" },
        { kind: "plugin", id: "p1", name: "Publish" },
        { kind: "workflow", id: "w1", name: "Launch content" },
        { kind: "plugin", id: "p2", name: "Old" },
        { kind: "plugin", id: "p2", name: "Old", deleted: true },
      ]),
    ).toEqual({
      workflows: [{ id: "w1", name: "Launch content" }],
      plugins: [{ id: "p1", name: "Publish" }],
    });
  });

  it("numbers messages in order, refuses a second open run, and deletes a chat with its messages", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const agent = await createAgent(d1, {
      orgId,
      name: "Builder",
      instructions: "",
      mcp: ["factory"],
    });
    const chat = await createChat(d1, { orgId, agentId: agent.id, text: "Hi", createdBy: "sam" });
    await expect(sendMessage(d1, chat.id, "Again")).rejects.toBeInstanceOf(StoreError);
    const view = await getChat(d1, chat.id);
    const runId = view?.messages[0]?.runId ?? "";
    await addDid(d1, {
      chatId: chat.id,
      orgId,
      runId,
      text: "Created the workflow W",
      data: { kind: "workflow", id: "w", name: "W" },
    });
    const after = await getChat(d1, chat.id);
    expect(after?.messages.map((m) => [m.seq, m.role])).toEqual([
      [1, "person"],
      [2, "did"],
    ]);
    expect(after?.working).toBe(true);
    expect(after?.made.workflows).toEqual([{ id: "w", name: "W" }]);
    expect((await chatHistory(d1, chat.id, 2, 10)).map((m) => m.text)).toEqual(["Hi"]);
    await deleteChat(d1, chat.id);
    expect(await getChat(d1, chat.id)).toBeNull();
    const run = await d1.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(runId).first();
    expect(run).toEqual({ status: "cancelled" });
  });
});
