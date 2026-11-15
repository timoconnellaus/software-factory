import { describe, expect, it } from "vitest";
import {
  type Actor,
  apply,
  checkWorkflow,
  type Effect,
  FlowError,
  type ItemEvent,
  type ItemState,
  replay,
  type Workflow,
} from "../src/index.ts";

const sam: Actor = { kind: "person", id: "sam" };
const writer: Actor = { kind: "agent", id: "writer" };

function workflow(input: unknown): Workflow {
  const checked = checkWorkflow(input);
  if (!checked.ok) throw new Error(checked.problems.map((p) => p.message).join("; "));
  return checked.workflow;
}

// Nothing here names a kind of work: an agent drafts, a person reviews, then it rests.
const draftReviewDone = workflow({
  id: "wf",
  name: "Draft, review, done",
  statuses: [
    { id: "draft", name: "Draft", owner: { kind: "agent", agentId: "writer" }, brief: "Write it." },
    { id: "review", name: "Review", owner: { kind: "person", userId: "sam" } },
    { id: "done", name: "Done", owner: { kind: "none" } },
  ],
});

function run(wf: Workflow, events: ItemEvent[]): { state: ItemState; effects: Effect[] } {
  let state: ItemState | null = null;
  let effects: Effect[] = [];
  for (const event of events) {
    const step = apply(wf, state, event);
    state = step.state;
    effects = step.effects;
  }
  if (!state) throw new Error("no events");
  return { state, effects };
}

describe("checkWorkflow", () => {
  it("accepts a workflow and fills the defaults", () => {
    expect(draftReviewDone.statuses[1]).toMatchObject({ brief: "", needsDecision: false });
  });

  it("refuses a status that points at one that doesn't exist", () => {
    const checked = checkWorkflow({
      id: "wf",
      name: "Broken",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" }, onDone: "nowhere" }],
    });
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.problems[0]?.message).toContain("nowhere");
  });

  it("refuses two statuses with one id, and a status that points at itself", () => {
    const twice = checkWorkflow({
      id: "wf",
      name: "Twice",
      statuses: [
        { id: "a", name: "A", owner: { kind: "none" } },
        { id: "a", name: "A again", owner: { kind: "none" } },
      ],
    });
    expect(twice.ok).toBe(false);
    const self = checkWorkflow({
      id: "wf",
      name: "Self",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" }, onReject: "a" }],
    });
    expect(self.ok).toBe(false);
  });
});

describe("an item moves through a workflow", () => {
  it("starts one run with the status's brief when it enters an agent's status", () => {
    const { state, effects } = run(draftReviewDone, [{ type: "created" }]);
    expect(state).toMatchObject({
      statusId: "draft",
      waiting: { on: "run", agentId: "writer" },
      stay: 1,
    });
    expect(effects.filter((e) => e.type === "run.start")).toEqual([
      { type: "run.start", agentId: "writer", statusId: "draft", brief: "Write it.", stay: 1 },
    ]);
  });

  it("puts it in the person's inbox when it enters a person's status", () => {
    const { state, effects } = run(draftReviewDone, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
    ]);
    expect(state).toMatchObject({ statusId: "review", waiting: { on: "person", userId: "sam" } });
    expect(effects).toContainEqual({
      type: "inbox.add",
      userId: "sam",
      statusId: "review",
      reason: "work",
    });
    expect(effects).toContainEqual({ type: "entered", from: "draft", to: "review", by: writer });
  });

  it("goes end to end, and rests in a status nobody owns", () => {
    const { state, effects } = run(draftReviewDone, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
      { type: "person.finished", by: sam, outcome: "done" },
    ]);
    expect(state).toMatchObject({ statusId: "done", waiting: { on: "nothing" }, error: null });
    expect(effects).toEqual([{ type: "entered", from: "review", to: "done", by: sam }]);
  });

  it("sends it back to the status before when rejected, and starts a fresh run", () => {
    const { state, effects } = run(draftReviewDone, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
      { type: "person.finished", by: sam, outcome: "rejected" },
    ]);
    expect(state).toMatchObject({ statusId: "draft", stay: 3 });
    expect(effects).toContainEqual(expect.objectContaining({ type: "run.start", stay: 3 }));
  });

  it("follows a named 'when done' and 'if rejected' over the list order", () => {
    const wf = workflow({
      id: "wf",
      name: "Named",
      statuses: [
        { id: "a", name: "A", owner: { kind: "agent", agentId: "x" }, onDone: "c" },
        { id: "b", name: "B", owner: { kind: "none" } },
        { id: "c", name: "C", owner: { kind: "agent", agentId: "y" }, onReject: "a" },
      ],
    });
    const done = run(wf, [{ type: "created" }, { type: "run.ended", stay: 1, outcome: "done" }]);
    expect(done.state.statusId).toBe("c");
    const back = apply(wf, done.state, { type: "run.ended", stay: 2, outcome: "rejected" });
    expect(back.state.statusId).toBe("a");
  });

  it("ignores a result from a stay the item has already left", () => {
    const moved = run(draftReviewDone, [
      { type: "created" },
      { type: "moved", by: sam, to: "review" },
    ]);
    expect(moved.effects).toContainEqual({ type: "run.cancel", stay: 1 });
    const late = apply(draftReviewDone, moved.state, {
      type: "run.ended",
      stay: 1,
      outcome: "done",
    });
    expect(late).toEqual({ state: moved.state, effects: [] });
  });
});

describe("a status that needs a person's decision", () => {
  const gated = workflow({
    id: "wf",
    name: "Gated",
    statuses: [
      { id: "check", name: "Check", owner: { kind: "agent", agentId: "qa" }, needsDecision: true },
      { id: "out", name: "Out", owner: { kind: "none" } },
    ],
  });

  it("waits for the decision after the agent is done", () => {
    const { state, effects } = run(gated, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
    ]);
    expect(state).toMatchObject({ statusId: "check", waiting: { on: "decision" } });
    expect(effects).toEqual([{ type: "decision.ask", statusId: "check" }]);
  });

  it("can't be left by an agent, only decided by a person", () => {
    const waiting = run(gated, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
    ]).state;
    expect(() => apply(gated, waiting, { type: "moved", by: writer, to: "out" })).toThrow(
      FlowError,
    );
    expect(() =>
      apply(gated, waiting, { type: "decided", by: writer, decision: "approve" }),
    ).toThrow(FlowError);
    const approved = apply(gated, waiting, { type: "decided", by: sam, decision: "approve" });
    expect(approved.state.statusId).toBe("out");
  });

  it("stays put when rejected with nowhere to send it back to", () => {
    const waiting = run(gated, [
      { type: "created" },
      { type: "run.ended", stay: 1, outcome: "done" },
    ]).state;
    const rejected = apply(gated, waiting, { type: "decided", by: sam, decision: "reject" });
    expect(rejected.state).toMatchObject({ statusId: "check", waiting: { on: "nothing" } });
  });

  it("treats the owner finishing their own status as the decision", () => {
    const wf = workflow({
      id: "wf",
      name: "Approve",
      statuses: [
        {
          id: "approve",
          name: "Approve",
          owner: { kind: "person", userId: "sam" },
          needsDecision: true,
        },
        { id: "out", name: "Out", owner: { kind: "none" } },
      ],
    });
    const { state } = run(wf, [
      { type: "created" },
      { type: "person.finished", by: sam, outcome: "done" },
    ]);
    expect(state.statusId).toBe("out");
  });
});

describe("failures", () => {
  it("stops the item with the error, and a retry starts the run again", () => {
    const failed = run(draftReviewDone, [
      { type: "created" },
      { type: "run.failed", stay: 1, error: "The runner went away." },
    ]);
    expect(failed.state).toMatchObject({ statusId: "draft", error: "The runner went away." });
    expect(failed.effects).toEqual([
      { type: "stopped", statusId: "draft", error: "The runner went away." },
    ]);

    const retried = apply(draftReviewDone, failed.state, { type: "retried", by: sam });
    expect(retried.state).toMatchObject({ error: null, stay: 2, waiting: { on: "run" } });
    expect(retried.effects).toEqual([
      { type: "run.start", agentId: "writer", statusId: "draft", brief: "Write it.", stay: 2 },
    ]);
  });

  it("refuses a retry when nothing failed, and events that don't fit", () => {
    const { state } = run(draftReviewDone, [{ type: "created" }]);
    expect(() => apply(draftReviewDone, state, { type: "retried", by: sam })).toThrow(FlowError);
    expect(() =>
      apply(draftReviewDone, state, { type: "person.finished", by: sam, outcome: "done" }),
    ).toThrow(FlowError);
    expect(() => apply(draftReviewDone, state, { type: "moved", by: sam, to: "nope" })).toThrow(
      FlowError,
    );
  });
});

describe("replay", () => {
  it("gives the same state for the same events, skipping ones that never fitted", () => {
    const events: ItemEvent[] = [
      { type: "created" },
      { type: "retried", by: sam },
      { type: "run.ended", stay: 1, outcome: "done" },
      { type: "person.finished", by: sam, outcome: "rejected" },
      { type: "run.failed", stay: 3, error: "boom" },
      { type: "retried", by: sam },
      { type: "run.ended", stay: 4, outcome: "done" },
    ];
    const once = replay(draftReviewDone, events);
    expect(once).toEqual(replay(draftReviewDone, events));
    expect(once).toMatchObject({ statusId: "review", stay: 5, error: null });
  });
});
