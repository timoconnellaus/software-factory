// The Live tab's logic (spec 31): folding polls, the transcript and the terminal.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveRunView } from "#/components/live-run-view";
import { latestStatus, mergeLive, shortInput, terminalText, transcriptItems } from "#/lib/live";
import type { LiveEvent, LiveSteer, LiveView } from "#/lib/ops";

const T = (s: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, s)).toISOString();
const ev = (seq: number, type: string, data: Record<string, unknown>): LiveEvent => ({
  seq,
  at: T(seq),
  type,
  data,
});

function view(runId: string, events: LiveEvent[], over: Partial<LiveView> = {}): LiveView {
  return {
    run: {
      id: runId,
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
      mode: null,
    },
    events,
    lastSeq: events.at(-1)?.seq ?? 0,
    truncated: false,
    steers: [],
    steer: { allowed: true, reason: null, max: 2000 },
    takeover: { allowed: false, reason: null, requested: false },
    ...over,
  };
}

function render(data: LiveView, initialView?: "transcript" | "terminal") {
  return renderToStaticMarkup(
    createElement(LiveRunView, {
      data,
      me: "u_me",
      onSteer: async () => {},
      ...(initialView ? { initialView } : {}),
    }),
  );
}

describe("the Live tab's view", () => {
  const events = [
    ev(1, "message", { role: "assistant", text: "Reading the spec." }),
    ev(2, "tool", { name: "Edit", input: '{"file_path":"README.md"}' }),
    ev(3, "log", { stream: "terminal", text: "$ pnpm test", screen: true }),
  ];

  it("gives the runner's owner a message box while the run is live", () => {
    const html = render(view("run_a", events));
    expect(html).toContain("Reading the spec.");
    expect(html).toContain("README.md");
    expect(html).toContain('data-testid="steer-form"');
    expect(html).not.toContain('data-testid="steer-readonly"');
  });

  it("shows everyone else the run read-only, with why", () => {
    const html = render(
      view("run_a", events, {
        steer: {
          allowed: false,
          reason: "Only the runner's owner can message the agent: it runs on their machine.",
          max: 2000,
        },
      }),
    );
    expect(html).not.toContain('data-testid="steer-form"');
    expect(html).toContain("Watching read-only.");
    expect(html).toContain("runner&#x27;s owner");
  });

  it("shows the terminal, and no message box once the run has ended", () => {
    const ended = view("run_a", events);
    if (ended.run) ended.run = { ...ended.run, active: false, status: "handed_back" };
    const html = render(ended, "terminal");
    expect(html).toContain("$ pnpm test");
    expect(html).not.toContain('data-testid="steer-form"');
    expect(html).not.toContain("Watching read-only");
  });
});

describe("the Live tab", () => {
  it("appends a poll's new events to the same run, and starts over for another run", () => {
    const first = view("run_a", [ev(1, "job.state", { state: "running" })]);
    const next = view("run_a", [ev(1, "job.state", {}), ev(2, "tool", { name: "Read" })]);
    const merged = mergeLive(first, next);
    expect(merged.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(merged.lastSeq).toBe(2);
    const other = view("run_b", [ev(1, "job.state", {})]);
    expect(mergeLive(merged, other)).toBe(other);
    expect(mergeLive(undefined, first)).toBe(first);
  });

  it("orders what the agent said, its tools, status and the steers by time", () => {
    const steer: LiveSteer = {
      id: "st_1",
      text: "also add a test",
      at: T(3),
      authorUserId: "u_me",
      authorName: "tim",
      status: "delivered",
      deliveredAt: T(3),
      kind: "message",
    };
    const items = transcriptItems(
      [
        ev(1, "agent.status", { status: "working" }),
        ev(2, "message", { role: "assistant", text: "Reading the spec." }),
        ev(4, "tool", { name: "Bash", input: '{"command":"pnpm   test --filter core"}' }),
        ev(5, "log", { stream: "terminal", text: "noise" }),
        ev(6, "agent.status", { status: "waiting_input", message: "Claude needs your permission" }),
        ev(7, "session.ended", { outcome: "completed" }),
      ],
      [steer],
    );
    expect(items.map((i) => i.kind)).toEqual([
      "status",
      "message",
      "steer",
      "tool",
      "status",
      "status",
    ]);
    expect(items[3]).toMatchObject({ name: "Bash", input: "pnpm test --filter core" });
    expect(items[4]).toMatchObject({
      text: "Waiting for input: Claude needs your permission",
      tone: "waiting",
    });
    expect(items[5]).toMatchObject({ text: "Session completed", tone: "done" });
  });

  it("shows the scrolled-off lines, then only the newest screen", () => {
    const text = terminalText([
      ev(1, "log", { stream: "terminal", text: "line 1\nline 2\n" }),
      ev(2, "log", { stream: "terminal", text: "old screen", screen: true }),
      ev(3, "log", { stream: "terminal", text: "line 3" }),
      ev(4, "log", { stream: "terminal", text: "new screen", screen: true }),
      ev(5, "tool", { name: "Read" }),
    ]);
    expect(text).toBe("line 1\nline 2\nline 3\nnew screen");
    expect(terminalText([ev(1, "log", { text: "y".repeat(50) })], 10)).toBe(`…\n${"y".repeat(10)}`);
  });

  it("shortens tool inputs and reads the latest status", () => {
    expect(shortInput('{"file_path":"/a/b.ts","content":"…"}')).toBe("/a/b.ts");
    expect(shortInput('{"command":"x'.padEnd(300, "y"))).toHaveLength(120);
    expect(shortInput(null)).toBeNull();
    expect(latestStatus([ev(1, "agent.status", { status: "working" })])).toBe("Working");
    expect(latestStatus([])).toBeNull();
  });
});
