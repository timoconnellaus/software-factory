// Spec 26: the planning hooks look for news at most every 2 s, with a read first (criterion 1);
// news too long for Claude Code's context keeps every answer and message, shortened or left for the
// next step, never replaced by a count (criterion 4); and what the agent was shown is acknowledged
// on the next call, so news a hook couldn't show comes again.
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
const answer = (cursor: number, text: string, prompt = "Which?"): PlanningNewsEvent => ({
  type: "answer.submitted",
  cursor,
  at: "2026-11-12T00:00:00.000Z",
  questionId: `q${cursor}`,
  number: cursor,
  prompt,
  answer: text,
  skipped: false,
  note: null,
  acceptedDefault: false,
  by: "Tim",
});
const news = (events: PlanningNewsEvent[]): PlanningNews => ({
  workItemId: "wi_1",
  cursor: (events.at(-1)?.cursor ?? 0) + 1,
  events,
  openQuestions: 0,
  present: ["Tim"],
  yield: false,
  ended: false,
});

/** A fake relay: answers peek and news, and records every call's op and input. */
function relayWith(answerNews: (input: Record<string, unknown>) => PlanningNews) {
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const { op, input } = JSON.parse(String(init.body)) as {
      op: string;
      input: Record<string, unknown>;
    };
    calls.push({ op, input });
    const result =
      op === "planning.peek"
        ? { latest: 99, news: true, yield: false, ended: false }
        : answerNews(input);
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const relay = { url: "http://relay", token: "t", jobId: "job_1", workItemNumber: 7 };

describe("planning news in the agent's context (spec 26)", () => {
  it("looks for news at most every 2 s while the agent works (criterion 1)", async () => {
    expect(PLANNING_NEWS_THROTTLE_MS).toBe(2_000);
    const dir = await mkdtemp(join(tmpdir(), "sf-hooks-"));
    const { calls, fetch } = relayWith(() => news([message(5, "Tab-separated, please.")]));
    const run = async (now: number) => {
      const r = await runNewsHook(
        "PostToolUse",
        { tool_name: "Read" },
        { relayFile: join(dir, "planning.json"), relay, now, fetch },
      );
      await r.save();
      return r.response;
    };
    const t = 1_000_000;
    expect(JSON.stringify(await run(t))).toContain("Tab-separated");
    expect(await run(t + 1_000)).toEqual({});
    const before = calls.length;
    await run(t + 2_000);
    expect(calls.length).toBeGreaterThan(before);
  });

  it("looks with a read first, and writes nothing when there's no news and the activity is the same", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-hooks-"));
    const calls: string[] = [];
    let hasNews = true;
    const fetch = (async (_url: string, init: RequestInit) => {
      const { op } = JSON.parse(String(init.body)) as { op: string };
      calls.push(op);
      const result =
        op === "planning.peek"
          ? { latest: 6, news: hasNews, yield: false, ended: false }
          : news([message(5, "Hi")]);
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof globalThis.fetch;
    const look = async (now: number) =>
      (
        await runNewsHook(
          "PostToolUse",
          { tool_name: "Read" },
          { relayFile: join(dir, "planning.json"), relay, now, fetch },
        )
      ).save();
    await look(1_000_000); // a new activity: news is called, once
    hasNews = false;
    calls.length = 0;
    await look(1_010_000);
    expect(calls).toEqual(["planning.peek"]);
  });

  it("acknowledges only what it showed, so news it couldn't show comes again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-hooks-"));
    const { calls, fetch } = relayWith(() => news([message(5, "First")]));
    const relayFile = join(dir, "planning.json");
    // A hook that never got to print (no save): its news isn't acknowledged.
    await runNewsHook("UserPromptSubmit", {}, { relayFile, relay, fetch });
    await runNewsHook("UserPromptSubmit", {}, { relayFile, relay, fetch }).then((r) => r.save());
    const newsCalls = calls.filter((c) => c.op === "planning.news");
    expect(newsCalls[0]?.input).toMatchObject({ hold: true });
    expect(newsCalls[0]?.input.ack).toBeUndefined();
    expect(newsCalls[1]?.input.ack).toBeUndefined();
    await runNewsHook("UserPromptSubmit", {}, { relayFile, relay, fetch });
    expect(calls.filter((c) => c.op === "planning.news").at(-1)?.input).toMatchObject({ ack: 6 });
  });

  it("keeps every answer and message when the news is too long: shortened, and the rest left for the next step (criterion 4)", () => {
    const long = "x".repeat(3_000);
    const events = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? message(40 + i, long) : answer(40 + i, long, long),
    );
    const { json, shown } = fitNews(news(events));
    expect(json.length).toBeLessThanOrEqual(9_500);
    const parsed = JSON.parse(json) as {
      events: PlanningNewsEvent[];
      shortened: string;
      more?: string;
    };
    expect(parsed.events.length).toBeGreaterThan(0);
    // The ones shown are the first ones, in order; the rest come next time, never as a count.
    expect(parsed.events.map((e) => e.cursor)).toEqual(
      events.slice(0, parsed.events.length).map((e) => e.cursor),
    );
    expect(shown).toBe(parsed.events.at(-1)?.cursor);
    expect(parsed.more).toContain(`${12 - parsed.events.length} more events`);
    expect(parsed.shortened).toContain("cursor 39");
  });

  it("shows one huge answer shortened rather than dropping it", () => {
    const huge = answer(70, "y".repeat(100_000), "z".repeat(10_000));
    const { json, shown } = fitNews(news([huge]));
    expect(json.length).toBeLessThanOrEqual(9_500);
    const parsed = JSON.parse(json) as { events: PlanningNewsEvent[] };
    expect(parsed.events).toEqual([expect.objectContaining({ cursor: 70, questionId: "q70" })]);
    expect(shown).toBe(71);
  });

  it("leaves news that fits as it is", () => {
    const small = news([answer(5, "Yes")]);
    expect(JSON.parse(fitNews(small).json)).toEqual(small);
    expect(fitNews(small).shown).toBe(small.cursor);
  });
});
