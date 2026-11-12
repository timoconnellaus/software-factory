// The Live tab's Chat view (spec 37, ADR 0450): a stream session's events as a conversation, the
// owner's composer and takeover, and the resume command.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveRunView } from "#/components/live-run-view";
import { chatItems, takeoverHint, turnLine } from "#/lib/chat";
import { transcriptItems } from "#/lib/live";
import type { LiveEvent, LiveSteer, LiveView } from "#/lib/ops";

const T = (s: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, s)).toISOString();
const ev = (seq: number, type: string, data: Record<string, unknown>): LiveEvent => ({
  seq,
  at: T(seq),
  type,
  data,
});

const steer = (over: Partial<LiveSteer> = {}): LiveSteer => ({
  id: "st_1",
  text: "also update the docs",
  at: T(5),
  authorUserId: "u_me",
  authorName: "tim",
  status: "delivered",
  deliveredAt: T(5),
  kind: "message",
  ...over,
});

const events = [
  ev(1, "session.started", { sessionRef: "stream:s", mode: "stream" }),
  ev(2, "agent.status", { status: "working" }),
  ev(3, "message", { role: "assistant", text: "Reading **the spec**." }),
  ev(4, "tool", { name: "Bash", input: '{"command":"pnpm test"}', id: "tu_1" }),
  ev(6, "tool.result", { toolId: "tu_1", output: "1 failed", isError: true }),
  ev(7, "tool", { name: "Read", input: '{"file_path":"a.ts"}', id: "tu_2" }),
  ev(8, "turn", {
    outcome: "success",
    durationMs: 8_400,
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 12_000,
      cacheWriteTokens: 400,
    },
  }),
];

function view(
  over: Partial<LiveView> = {},
  run: Partial<NonNullable<LiveView["run"]>> = {},
): LiveView {
  return {
    run: {
      id: "run_a",
      jobId: "job_1",
      runNo: 1,
      stage: "build",
      status: "running",
      outcome: null,
      active: true,
      runnerId: "r_1",
      runnerName: "M5",
      startedAt: T(0),
      endedAt: null,
      takeover: null,
      mode: "stream",
      ...run,
    },
    events,
    lastSeq: 8,
    truncated: false,
    steers: [steer()],
    steer: { allowed: true, reason: null, max: 2000 },
    takeover: { allowed: true, reason: null, requested: false },
    terminal: { allowed: false, mode: null, reason: "A stream session has no terminal." },
    ...over,
  };
}

const render = (data: LiveView, initialView?: "chat" | "transcript" | "terminal") =>
  renderToStaticMarkup(
    createElement(LiveRunView, {
      data,
      me: "u_me",
      onSteer: async () => {},
      onTakeover: async () => {},
      ...(initialView ? { initialView } : {}),
    }),
  );

describe("the chat's items", () => {
  it("pairs tool calls with their results, keeps turns, drops working, adds people's messages", () => {
    const items = chatItems(events, [steer()]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool", "person", "tool", "turn"]);
    const [, bash, , read] = items;
    expect(bash).toMatchObject({
      name: "Bash",
      summary: "pnpm test",
      output: "1 failed",
      isError: true,
      pending: false,
    });
    expect(bash?.kind === "tool" && bash.input).toBe('{\n  "command": "pnpm test"\n}');
    expect(read).toMatchObject({ name: "Read", pending: true, output: null });
  });

  it("says a turn's tokens and time briefly", () => {
    const turn = chatItems(events, []).find((i) => i.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("no turn");
    expect(turnLine(turn)).toBe("1.2k in · 340 out · 12.4k cached · 8.4 s");
  });

  it("shows a takeover request as a status, and the handover's command", () => {
    const asked = steer({ id: "st_t", kind: "takeover", text: "", at: T(9) });
    const handed = [
      ...events,
      ev(10, "takeover", { sessionId: "s", hint: "cd /w && claude --resume s" }),
    ];
    const items = chatItems(handed, [asked]);
    expect(items.at(-2)).toMatchObject({
      kind: "status",
      text: expect.stringMatching(/Takeover asked/),
    });
    expect(items.at(-1)).toMatchObject({ kind: "takeover", hint: "cd /w && claude --resume s" });
    expect(takeoverHint(handed)).toBe("cd /w && claude --resume s");
    // The terminal view's transcript copes with both too.
    const transcript = transcriptItems(handed, [asked]);
    expect(transcript.some((i) => i.kind === "steer")).toBe(false);
    expect(transcript.at(-1)).toMatchObject({ kind: "status", text: /Handed over/ });
  });
});

describe("the Chat view", () => {
  it("is the default for a stream run: Markdown, collapsible tools, turns, a composer and takeover", () => {
    const html = render(view());
    expect(html).toContain('data-testid="live-chat-tab"');
    expect(html).toContain('data-testid="live-chat"');
    expect(html).toContain("<strong>the spec</strong>");
    expect(html).toContain('data-testid="chat-tool"');
    expect(html).toContain("pnpm test");
    expect(html).toContain('data-testid="chat-turn"');
    expect(html).toContain('data-testid="chat-person"');
    expect(html).toContain("also update the docs");
    expect(html).toContain('data-testid="chat-composer"');
    expect(html).toContain('data-testid="takeover-button"');
    // One composer: the transcript's steer box isn't shown under the chat.
    expect(html).not.toContain('data-testid="steer-form"');
  });

  it("is read-only for everyone but the runner's owner", () => {
    const html = render(
      view({
        steer: {
          allowed: false,
          reason: "Only the runner's owner can message the agent.",
          max: 2000,
        },
        takeover: { allowed: false, reason: "Only the runner's owner…", requested: false },
      }),
    );
    expect(html).not.toContain('data-testid="chat-composer"');
    expect(html).not.toContain('data-testid="takeover-button"');
    expect(html).toContain('data-testid="chat-readonly"');
  });

  it("shows the resume command once handed over, and no composer", () => {
    const html = render(
      view({
        events: [
          ...events,
          ev(10, "takeover", { sessionId: "s", hint: "cd /w && claude --resume s" }),
        ],
        takeover: { allowed: false, reason: "already", requested: true },
      }),
    );
    expect(html).toContain('data-testid="takeover-command"');
    expect(html).toContain("claude --resume s");
    expect(html).not.toContain('data-testid="chat-composer"');
    const pending = render(
      view({ takeover: { allowed: false, reason: "already", requested: true } }),
    );
    expect(pending).toContain('data-testid="takeover-pending"');
  });

  it("isn't offered for a terminal run; its transcript and terminal are as before", () => {
    const html = render(view({}, { mode: "terminal" }));
    expect(html).not.toContain('data-testid="live-chat-tab"');
    expect(html).toContain('data-testid="live-stream"');
    expect(html).toContain('data-testid="steer-form"');
    // A stream run can still be read as a transcript.
    expect(render(view(), "transcript")).toContain('data-testid="live-stream"');
  });
});
