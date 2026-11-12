// The Factory pages through the real router (spec 41, slice 5): while a read is out each section
// shows a skeleton, a failed read shows the error with Retry, and the empty message ("Nothing is
// running", "You have no runners yet") appears only when the read answered and was empty.
import { describe, expect, it, vi } from "vitest";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const PENDING = 'data-testid="read-pending"';
const ERROR = 'data-testid="read-error"';
const failed = { error: "the factory isn't reachable" };

describe("Overview", () => {
  const EMPTY = [
    "Nothing is running.",
    "Nothing is waiting for a slot.",
    "Nothing is waiting to merge.",
    "No open incidents.",
  ];

  it("shows skeletons, not empty messages, while its reads are out", async () => {
    const html = await renderPage("/factory", { pending: [["work"], ["mergeQueue"]] });
    expect(html).toContain(PENDING);
    expect(html).not.toContain(ERROR);
    for (const line of EMPTY) expect(textOf(html)).not.toContain(line);
  });

  it("shows the error with Retry when a read failed", async () => {
    const html = await renderPage("/factory", {
      answers: { "workItem.list": failed, "mergeQueue.list": failed },
    });
    const text = textOf(html);
    expect(html).toContain(ERROR);
    expect(text).toContain("Couldn't load what is running. the factory isn't reachable Retry");
    expect(text).toContain("Couldn't load the merge queues.");
    for (const line of EMPTY) expect(text).not.toContain(line);
  });

  it("says nothing runs only when the reads answered empty", async () => {
    const html = await renderPage("/factory", {
      answers: {
        "workItem.list": { result: { items: [] } },
        "mergeQueue.list": { result: { entries: [] } },
      },
    });
    const text = textOf(html);
    expect(html).not.toContain(PENDING);
    expect(html).not.toContain(ERROR);
    for (const line of EMPTY) expect(text).toContain(line);
  });

  it("shows the figures and tables when there is work", async () => {
    const text = textOf(await renderPage("/factory"));
    expect(text).toContain("Queued 1 waiting for a slot");
    expect(text).toContain("#42 Keep the runner count fresh");
    expect(text).toContain("1 open incident.");
  });
});

describe("Runners", () => {
  it("shows a skeleton while the runners load", async () => {
    const html = await renderPage("/factory/runners", { pending: [["runners"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("You have no runners yet");
  });

  it("shows the error with Retry when the runners read failed", async () => {
    const html = await renderPage("/factory/runners", { answers: { "runner.list": failed } });
    expect(html).toContain(ERROR);
    expect(textOf(html)).toContain("Couldn't load the runners.");
    expect(textOf(html)).not.toContain("You have no runners yet");
  });

  it("says you have none only when the read answered empty", async () => {
    const html = await renderPage("/factory/runners", {
      answers: { "runner.list": { result: { runners: [] } } },
    });
    expect(html).not.toContain(PENDING);
    expect(textOf(html)).toContain("You have no runners yet. Pair one in Setup");
  });

  it("shows when it was last heard relative, with the full date on hover", async () => {
    const html = await renderPage("/factory/runners");
    expect(textOf(html)).toMatch(/Last heard (just now|\dm( \d+s)? ago)/);
    expect(html).toMatch(/<time dateTime="[^"]+" title="[A-Z][a-z]+day, \d+ [A-Z][a-z]+ \d{4} at /);
  });
});

describe("Checks and incidents", () => {
  it("shows skeletons while the work items load", async () => {
    const html = await renderPage("/factory/incidents", { pending: [["work"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("No open incidents");
  });

  it("shows the error with Retry when the read failed", async () => {
    const html = await renderPage("/factory/incidents", { answers: { "workItem.list": failed } });
    expect(html).toContain(ERROR);
    expect(textOf(html)).not.toContain("No open incidents");
    expect(textOf(html)).not.toContain("No closed incidents");
  });

  it("says there are none only when the read answered without incidents", async () => {
    const text = textOf(
      await renderPage("/factory/incidents", {
        answers: { "workItem.list": { result: { items: [] } } },
      }),
    );
    expect(text).toContain("No open incidents.");
    expect(text).toContain("No closed incidents yet.");
  });

  it("shows each incident's title as the factory wrote it", async () => {
    const text = textOf(await renderPage("/factory/incidents"));
    expect(text).toContain("Factory incident: #8 had a run that failed");
    expect(text).toContain("#40, waiting: packet ready · PR #47");
  });
});
