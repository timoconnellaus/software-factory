// Spec 26: the planning hooks look for news at most every 2 s (criterion 1), and news too long for
// Claude Code's context keeps every answer and message and names the right cursor (criterion 4).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanningNews, PlanningNewsEvent } from "@software-factory/runner-contract";
import { PLANNING_NEWS_THROTTLE_MS } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { fitNews, runNewsHook } from "../src/index.ts";

const message = (cursor: number, text: string): PlanningNewsEvent => ({
  type: "chat.message",
  cursor,
  at: "2026-11-12T00:00:00.000Z",
  messageId: `m${cursor}`,
  text,
  from: "Tim",
  questionId: null,
  about: null,
  kind: "chat",
});
const answer = (cursor: number, text: string): PlanningNewsEvent => ({
  type: "answer.submitted",
  cursor,
  at: "2026-11-12T00:00:00.000Z",
  questionId: `q${cursor}`,
  number: cursor,
  prompt: "Which?",
  answer: text,
  skipped: false,
  note: null,
  acceptedDefault: false,
  by: "Tim",
});
const news = (events: PlanningNewsEvent[]): PlanningNews => ({
  workItemId: "wi_1",
  cursor: events.at(-1)?.cursor ?? 0,
  events,
  openQuestions: 0,
  present: ["Tim"],
  yield: false,
  ended: false,
});

describe("planning news in the agent's context (spec 26)", () => {
  it("looks for news at most every 2 s while the agent works (criterion 1)", async () => {
    expect(PLANNING_NEWS_THROTTLE_MS).toBe(2_000);
    const dir = await mkdtemp(join(tmpdir(), "sf-hooks-"));
    const relay = { url: "http://relay", token: "t", jobId: "job_1", workItemNumber: 7 };
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ ok: true, result: news([message(calls, "Tab-separated, please.")]) }),
      );
    }) as typeof fetch;
    const run = (now: number) =>
      runNewsHook(
        "PostToolUse",
        { tool_name: "Read" },
        { relayFile: join(dir, "planning.json"), relay, now, fetch: fakeFetch },
      );
    const t = 1_000_000;
    const firstLook = await run(t);
    expect(JSON.stringify(firstLook)).toContain("Tab-separated");
    expect(await run(t + 1_000)).toEqual({});
    expect(calls).toBe(1);
    expect(JSON.stringify(await run(t + 2_000))).toContain("Tab-separated");
    expect(calls).toBe(2);
  });

  it("keeps every answer and message when the news is too long, and points at the cursor before them (criterion 4)", () => {
    const long = "x".repeat(3_000);
    const events = [
      { type: "presence.changed", cursor: 40, at: "", present: ["Tim"] } as PlanningNewsEvent,
      answer(41, long),
      message(42, long),
      answer(43, long),
      message(44, long),
    ];
    const text = fitNews(news(events));
    expect(text.length).toBeLessThanOrEqual(9_500);
    const parsed = JSON.parse(text) as { events: PlanningNewsEvent[]; shortened: string };
    expect(parsed.events.map((e) => e.cursor)).toEqual([41, 42, 43, 44]);
    // Read again from just before the first event: every shortened one comes back.
    expect(parsed.shortened).toContain("cursor 39");
  });

  it("names the cursor to read from when even shortened news doesn't fit", () => {
    const events = Array.from({ length: 200 }, (_, i) => message(100 + i, "y".repeat(400)));
    const parsed = JSON.parse(fitNews(news(events))) as { events: string };
    expect(parsed.events).toContain("200 events");
    expect(parsed.events).toContain("cursor 99");
  });

  it("leaves news that fits as it is", () => {
    const small = news([answer(5, "Yes")]);
    expect(JSON.parse(fitNews(small))).toEqual(small);
  });
});
