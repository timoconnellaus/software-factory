import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  addDid,
  chatHistory,
  chatTitle,
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

  it("lists each thing made once, by its latest name, drops a deleted one, and counts items only once created", () => {
    expect(
      madeOf([
        { kind: "workflow", id: "w1", name: "Launch" },
        { kind: "agent", id: "a1", name: "Research" },
        { kind: "plugin", id: "p1", name: "Publish" },
        { kind: "workflow", id: "w1", name: "Launch content" },
        { kind: "plugin", id: "p2", name: "Old" },
        { kind: "plugin", id: "p2", name: "Old", deleted: true },
        { kind: "item", id: "i1", name: "Draft", created: true, projectId: "p", number: 4 },
        { kind: "item", id: "i1", name: "Draft the post" },
        { kind: "item", id: "i2", name: "Moved, not made here" },
        { kind: "project", id: "pr1", name: "Notes", created: true },
        { kind: "gateway", id: "gh", name: "gh" },
      ]),
    ).toEqual({
      items: [{ id: "i1", name: "Draft the post", projectId: "p", number: 4 }],
      projects: [{ id: "pr1", name: "Notes" }],
      workflows: [{ id: "w1", name: "Launch content" }],
      plugins: [{ id: "p1", name: "Publish" }],
      agents: [{ id: "a1", name: "Research" }],
      gateways: [{ id: "gh", name: "gh" }],
    });
  });

  it("keeps a chat's model and effort, and changes them from a message on", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const chat = await createChat(d1, {
      orgId,
      text: "Hi",
      createdBy: "sam",
      model: "sonnet",
      effort: "low",
    });
    expect(chat).toMatchObject({ agentId: null, model: "sonnet", effort: "low" });
    // A refused send (a run is open) changes nothing.
    await expect(sendMessage(d1, chat.id, "Again", { model: "opus" })).rejects.toBeInstanceOf(
      StoreError,
    );
    expect((await getChat(d1, chat.id))?.chat.model).toBe("sonnet");
    await d1.prepare("UPDATE flow_runs SET status = 'done' WHERE chat_id = ?").bind(chat.id).run();
    await sendMessage(d1, chat.id, "Again", { model: "opus" });
    const view = await getChat(d1, chat.id);
    expect(view?.chat).toMatchObject({ model: "opus", effort: "low" });
    expect(view?.workingRunId).toMatch(/^frun_/);
  });

  it("numbers messages in order, refuses a second open run, and deletes a chat with its messages", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const chat = await createChat(d1, { orgId, text: "Hi", createdBy: "sam" });
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
