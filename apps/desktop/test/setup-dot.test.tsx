// Unfinished setup is an orange dot, not an Inbox item: the sidebar's Settings and Settings' Setup
// show it while `setup.status` says setup isn't complete, and nothing while it is complete, while
// the read is out or when it failed. The Inbox lists no setup entry and its count is unchanged.
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { setupUnfinished } from "../src/mainview/lib/setup-dot.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const unfinished = ANSWERS["setup.status"]?.({ orgId: "org_personal" });
const finished = { ...unfinished, complete: true };
const failed = { error: "the factory isn't reachable" };
const DOT = 'data-testid="setup-dot"';
const dots = (html: string) => html.split(DOT).length - 1;

describe("the setup dot's source", () => {
  it("is shown only on a successful read that says setup isn't complete", () => {
    expect(setupUnfinished({ status: "success", data: { complete: false } })).toBe(true);
    expect(setupUnfinished({ status: "success", data: { complete: true } })).toBe(false);
    expect(setupUnfinished({ status: "pending" })).toBe(false);
    // A refetch that failed keeps the old data, but the dot isn't shown on a guess.
    expect(setupUnfinished({ status: "error", data: { complete: false } })).toBe(false);
  });
});

describe("the dots on Settings and Setup", () => {
  it("shows both, labelled, while setup is unfinished", async () => {
    expect(unfinished?.complete).toBe(false);
    const html = await renderPage("/settings", {
      answers: { "setup.status": { result: unfinished } },
    });
    expect(dots(html)).toBe(2);
    expect(html).toContain('aria-label="Setup isn&#x27;t finished"');
  });

  it("shows the sidebar's dot on every page, not only in Settings", async () => {
    const html = await renderPage("/work", { answers: { "setup.status": { result: unfinished } } });
    expect(dots(html)).toBe(1);
  });

  it("hides both when setup is finished", async () => {
    const html = await renderPage("/settings", {
      answers: { "setup.status": { result: finished } },
    });
    expect(dots(html)).toBe(0);
  });

  it("hides both while the read is out", async () => {
    const html = await renderPage("/settings", { pending: [["setup"]] });
    expect(dots(html)).toBe(0);
  });

  it("hides both when the read failed", async () => {
    const html = await renderPage("/settings", { answers: { "setup.status": failed } });
    expect(dots(html)).toBe(0);
  });
});

describe("the Inbox with setup unfinished", () => {
  it("lists no setup entry and counts only what waits on you", async () => {
    const html = await renderPage("/", { answers: { "setup.status": { result: unfinished } } });
    expect(html).not.toContain('data-testid="inbox-row-setup"');
    expect(textOf(html)).not.toContain("Finish setup");
    // The fixture inbox: one merge, one spec, one question and one release flag wait on you.
    expect(html).toMatch(/data-testid="inbox-count"[^>]*>4</);
  });
});
