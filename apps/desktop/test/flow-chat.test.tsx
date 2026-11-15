// Chat through the real router (migrations 0433, 0437), on the fixture door's chats
// (screenshots/chat-fixtures.ts): a conversation with a model, its Markdown replies under the model's
// name, the did rows, the side pane only once the chat made something, the working state, a failed
// run, and a new chat's one line with its examples. Sending, the live steps and the pickers are
// clicked through in screenshots/behave.mjs.
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { flowChatOptionsQuery } from "../src/mainview/lib/flow-chat-queries.ts";
import { flowProjectsQuery, flowWorkflowQuery } from "../src/mainview/lib/flow-queries.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const CHAT = "/flow/org_personal/chat";
const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The pickers, the side pane's workflow and its items' keys are read inside the page. */
const reads = async (client: QueryClient) => {
  await client.prefetchQuery(flowChatOptionsQuery("org_personal"));
  await client.prefetchQuery(flowWorkflowQuery("org_personal", "fwf_launch"));
  await client.prefetchQuery(flowProjectsQuery("org_personal"));
};

describe("Chat", () => {
  it("is a plain conversation: a Markdown reply under the model's name, and no side pane", async () => {
    const html = await renderPage(`${CHAT}?chat=fchat_plain`, { after: reads });
    const text = textOf(html);
    expect(count(html, 'data-testid="chat-person"')).toBe(1);
    expect(count(html, 'data-testid="chat-reply"')).toBe(1);
    expect(html).toContain("<table");
    expect(html).toContain("<h4");
    expect(html).toContain("<pre");
    expect(text).toContain("Opus");
    expect(html).not.toContain('data-testid="chat-made"');
    expect(text).not.toMatch(/Builder|agent is working/);
    // The pickers beside the send button.
    expect(html).toContain('data-testid="chat-model"');
    expect(html).toContain('data-testid="chat-effort"');
  });

  it("lists what a chat made beside it: its items by key, and the workflow and plugin", async () => {
    const items = textOf(await renderPage(`${CHAT}?chat=fchat_notes`, { after: reads }));
    expect(items).toContain("API-13 Index note titles and bodies");
    expect(items).toContain("Sonnet");
    const built = await renderPage(`${CHAT}?chat=fchat_launch`, { after: reads });
    const text = textOf(built);
    expect(count(built, 'data-testid="chat-did"')).toBe(3);
    expect(text).toContain("Created the workflow Launch content (5 statuses)");
    expect(text).toContain("Brief → Research → Draft → Edit → Published");
    expect(text).toContain("Publish to the blog");
    expect(built).not.toContain('data-testid="chat-working"');
  });

  it("shows the run working where its reply will go, and waits to send", async () => {
    const html = await renderPage(`${CHAT}?chat=fchat_legal`);
    expect(html).toContain('data-testid="chat-working"');
    expect(textOf(html)).toContain("Thinking…");
    expect(textOf(html)).toContain("Added the agent Legal");
    expect(html).toMatch(
      /data-testid="chat-send"[^>]*disabled|disabled[^>]*data-testid="chat-send"/,
    );
  });

  it("says plainly when a run failed", async () => {
    const text = textOf(await renderPage(`${CHAT}?chat=fchat_slack`));
    expect(text).toContain("I couldn't finish that: The runner stopped responding.");
  });

  it("starts a new chat with one line and three examples", async () => {
    const html = await renderPage(CHAT);
    expect(html).toContain('data-testid="chat-empty"');
    expect(textOf(html)).toContain("New chat");
    expect(textOf(html)).toContain("What would you like to talk about?");
    expect(count(html, 'data-testid="chat-example"')).toBe(3);
  });
});
