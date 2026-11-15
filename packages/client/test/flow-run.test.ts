// The run view's logic (.kim/mockups/run.html): tool calls paired with their results, the time bar
// laid out by the events' timestamps, the words for durations, cost and status, and paging events.
import { describe, expect, it } from "vitest";
import {
  axisLabels,
  type FlowRunEvent,
  type FlowRunEvents,
  plumbingWords,
  RUN_EVENTS_PAGE,
  readNewEvents,
  runCost,
  runDuration,
  runLine,
  runPill,
  runSpan,
  runSteps,
  sinceStart,
  stepDuration,
  stepInput,
  stepLabel,
  stepMs,
  timeBar,
} from "../src/flow-run.ts";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const EVENTS: FlowRunEvent[] = [
  { seq: 1, at: at(10), kind: "note", text: "Plan." },
  { seq: 2, at: at(20), kind: "tool", name: "Read", label: "a.go", input: "{}", toolId: "t1" },
  { seq: 3, at: at(22), kind: "result", toolId: "t1", output: "package a", isError: false },
  { seq: 4, at: at(50), kind: "tool", name: "Bash", label: "Run tests", input: "{}", toolId: "t2" },
  { seq: 5, at: at(80), kind: "result", toolId: "t2", output: "FAIL", isError: true },
  // A tmux runner's call: no id, no result.
  { seq: 6, at: at(90), kind: "tool", name: "Edit", label: "a.go", input: "{}", toolId: null },
  { seq: 7, at: at(95), kind: "note", text: "Done." },
];

describe("runSteps", () => {
  it("pairs each tool call with its result by id, in order, and keeps notes", () => {
    const steps = runSteps(EVENTS);
    expect(steps.map((s) => s.kind)).toEqual(["note", "tool", "tool", "tool", "note"]);
    const [, read, bash, edit] = steps;
    expect(read).toMatchObject({ name: "Read", output: "package a", isError: false });
    expect(bash).toMatchObject({ name: "Bash", output: "FAIL", isError: true });
    expect(edit).toMatchObject({ name: "Edit", output: null, endAt: null });
    expect(read && stepMs(read)).toBe(2000);
    expect(bash && stepMs(bash)).toBe(30_000);
    expect(edit && stepMs(edit)).toBeNull();
  });

  it("drops a result whose call it never saw", () => {
    const steps = runSteps([
      { seq: 1, at: at(1), kind: "result", toolId: "x", output: "?", isError: false },
    ]);
    expect(steps).toEqual([]);
  });
});

describe("the time bar", () => {
  const run = { createdAt: at(0), claimedAt: at(0), finishedAt: at(100) };
  it("spans claimed to finished, laying model and tool time by the timestamps", () => {
    const steps = runSteps(EVENTS);
    const span = runSpan(run, steps);
    expect(span).toEqual({ start: T0, end: T0 + 100_000 });
    const bar = timeBar(steps, span);
    // Tool time: Read 20→22, Bash 50→80; the Edit has no result, so no tool time.
    expect(bar.tools.map((t) => [t.left, Math.round(t.width)])).toEqual([
      [20, 2],
      [50, 30],
    ]);
    // Model time: 0→20 (ended in a note), 22→50, 80→90, 90→100 (a note).
    expect(bar.model.map((m) => [m.left, Math.round(m.width), m.tone])).toEqual([
      [0, 20, "say"],
      [22, 28, "think"],
      [80, 10, "think"],
      [90, 10, "say"],
    ]);
  });

  it("runs to now while the run is in flight", () => {
    const steps = runSteps(EVENTS.slice(0, 2));
    const span = runSpan({ ...run, finishedAt: null }, steps, T0 + 60_000);
    expect(span.end).toBe(T0 + 60_000);
  });

  it("labels its axis from 0 to the whole run, the middle rounded", () => {
    expect(axisLabels(903_000)).toEqual(["0s", "5m", "10m", "15m 3s"]);
    expect(axisLabels(90_000)).toEqual(["0s", "30s", "1m", "1m 30s"]);
  });
});

describe("words", () => {
  it("says durations, step times, offsets and cost", () => {
    expect(runDuration(903_000)).toBe("15m 3s");
    expect(runDuration(42_000)).toBe("42s");
    expect(runDuration(3_840_000)).toBe("1h 4m");
    expect(stepDuration(1_600)).toBe("1.6s");
    expect(stepDuration(30_000)).toBe("30s");
    expect(sinceStart(T0 + 495_000, T0)).toBe("+08:15");
    expect(sinceStart(T0 + 3_723_000, T0)).toBe("+1:02:03");
    expect(runCost(1.375)).toBe("$1.38");
    expect(runCost(0.004)).toBe("<$0.01");
  });

  it("names a run's status for its header", () => {
    expect(runPill("done").label).toBe("Finished");
    expect(runPill("claimed").label).toBe("Running");
    expect(runPill("failed")).toEqual({ label: "Failed", tone: "bad" });
    expect(runPill("cancelled").label).toBe("Cancelled");
  });

  it("writes the run line: how long, the cost only when known, and its steps", () => {
    const run = { claimedAt: at(0), finishedAt: at(903), steps: 13 };
    expect(runLine({ ...run, costUsd: null })).toEqual(["15m 3s", "13 steps"]);
    expect(runLine({ ...run, costUsd: 1.38 })).toEqual(["15m 3s", "$1.38", "13 steps"]);
    expect(runLine({ claimedAt: at(0), finishedAt: null, steps: 1 })).toEqual(["1 step"]);
  });

  it("shows a Bash call's command, other inputs as indented JSON", () => {
    expect(stepInput("Bash", JSON.stringify({ command: "go test ./...", description: "x" }))).toBe(
      "go test ./...",
    );
    expect(stepInput("Read", JSON.stringify({ file_path: "a.go" }))).toBe(
      '{\n  "file_path": "a.go"\n}',
    );
    expect(stepInput("Read", '{"file_path": "a.g')).toBe('{"file_path": "a.g');
  });
});

describe("readNewEvents", () => {
  const ev = (seq: number): FlowRunEvent => ({ seq, at: at(seq), kind: "note", text: `${seq}` });
  it("asks again with the last seq while a page comes back full, and appends", async () => {
    const all = Array.from({ length: RUN_EVENTS_PAGE + 3 }, (_, i) => ev(i + 1));
    const asked: (number | undefined)[] = [];
    const read = async (after: number | undefined): Promise<FlowRunEvents> => {
      asked.push(after);
      const rest = all.filter((e) => after === undefined || e.seq > after);
      return { events: rest.slice(0, RUN_EVENTS_PAGE), truncated: false, done: false };
    };
    const first = await readNewEvents(read, []);
    expect(asked).toEqual([undefined, RUN_EVENTS_PAGE]);
    expect(first.events).toHaveLength(RUN_EVENTS_PAGE + 3);
    const again = await readNewEvents(read, first.events);
    expect(asked.at(-1)).toBe(RUN_EVENTS_PAGE + 3);
    expect(again.events).toHaveLength(RUN_EVENTS_PAGE + 3);
  });
});

describe("step labels", () => {
  const dir = "worktrees/sf-frun_1";
  it("shows a file tool's path from the run's working folder", () => {
    expect(stepLabel({ name: "Read", label: `${dir}/src/a.ts` }, "frun_1")).toBe("src/a.ts");
    expect(stepLabel({ name: "Edit", label: `/Users/x/${dir}/README.md` }, "frun_1")).toBe(
      "README.md",
    );
    expect(stepLabel({ name: "Read", label: "/etc/hosts" }, "frun_1")).toBe("/etc/hosts");
    expect(stepLabel({ name: "Bash", label: `ls ${dir}/` }, "frun_1")).toBe(`ls ${dir}/`);
  });

  it("names every run's plumbing in plain words", () => {
    const read = (label: string) => plumbingWords({ name: "Read", label }, "frun_1");
    expect(read(`${dir}/.factory-prompt.md`)).toBe("Read its instructions");
    expect(plumbingWords({ name: "Write", label: `${dir}/.factory-result.json` }, "frun_1")).toBe(
      "Wrote its result",
    );
    expect(read(`${dir}/docs/.factory-prompt.md`)).toBe(null);
    expect(read(`${dir}/src/a.ts`)).toBe(null);
  });
});
