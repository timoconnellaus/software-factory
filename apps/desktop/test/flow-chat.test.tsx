// Chat through the real router (migration 0433), on the fixture door's chats
// (screenshots/chat-fixtures.ts): the conversation with the person's messages, the agent's replies
// and its did rows, the live pane's workflow and plugin, the working state, a failed run, and a new
// chat's one line. Sending is clicked through in screenshots/behave.mjs.
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { flowWorkflowQuery } from "../src/mainview/lib/flow-queries.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const CHAT = "/flow/org_personal/chat";
const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The live pane reads each workflow the chat made inside itself. */
const launch = async (client: QueryClient) => {
  await client.prefetchQuery(flowWorkflowQuery("org_personal", "fwf_launch"));
};

describe("Chat", () => {
  it("shows the conversation, what the agent did, and the workflow and plugin it made", async () => {
    const html = await renderPage(`${CHAT}?chat=fchat_launch`, { after: launch });
    const text = textOf(html);
    expect(text).toContain("Set up a workflow for launch content");
    expect(count(html, 'data-testid="chat-person"')).toBe(2);
    expect(count(html, 'data-testid="chat-reply"')).toBe(2);
    expect(count(html, 'data-testid="chat-did"')).toBe(3);
    expect(text).toContain("Created the workflow Launch content (5 statuses)");
    expect(text).toContain("Built the plugin Publish to the blog");
    expect(count(html, 'data-testid="live-status"')).toBe(5);
    expect(text).toContain("Research L Lead");
    expect(text).toContain("Edit MC Mia Chen");
    expect(text).toContain("Published – Nobody");
    expect(text).toContain("Plugins built in this chat Publish to the blog");
    expect(html).not.toContain('data-testid="chat-working"');
  });

  it("shows the agent working where its reply will go, and waits to send", async () => {
    const html = await renderPage(`${CHAT}?chat=fchat_legal`);
    expect(textOf(html)).toContain("Builder is working…");
    expect(textOf(html)).toContain("Added the agent Legal");
    expect(html).toMatch(
      /data-testid="chat-send"[^>]*disabled|disabled[^>]*data-testid="chat-send"/,
    );
  });

  it("says plainly when a run failed", async () => {
    const text = textOf(await renderPage(`${CHAT}?chat=fchat_slack`));
    expect(text).toContain("I couldn't finish that: The runner stopped responding.");
  });

  it("starts a new chat with one line suggesting what to ask", async () => {
    const html = await renderPage(CHAT);
    expect(html).toContain('data-testid="chat-empty"');
    expect(textOf(html)).toContain("New chat");
    expect(textOf(html)).toContain("Set up a workflow for launch content");
  });
});
