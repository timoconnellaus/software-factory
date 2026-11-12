// The event log's wording (spec wi-4, criteria 4 and 5): every known operation, the held, refused,
// failed and merged rules, and a graceful fallback for anything unexpected.
import { describe, expect, it } from "vitest";
import { actorLabel, describeEntry, LABELS, type TimelineEntry } from "../src/index.ts";

function entry(operation: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    operation,
    actorType: "agent",
    actorId: "foreman",
    outcome: "ok",
    reason: "autonomy policy balanced",
    result: null,
    ...over,
  };
}

// The detail each kind takes from its result; every other kind in the table has none.
const DETAILS: Record<string, [unknown, string]> = {
  "workItem.triage": [{ size: "small", reason: "One component" }, "Sized small. One component"],
  "workItem.enterStage": [{ stage: "build" }, "Entered build"],
  "workItem.create": [{ outcome: "duplicate" }, "duplicate"],
  "pr.open": [{ prNumber: 42 }, "PR #42"],
  "question.ask": [{ questionIds: ["q_1", "q_2"] }, "2 questions"],
  "spec.commit": [{ path: "docs/specs/wi-1.md" }, "docs/specs/wi-1.md"],
};

describe("describeEntry", () => {
  it.each(Object.entries(LABELS))("words %s as %j", (operation, label) => {
    const [result, detail] = DETAILS[operation] ?? [{ anything: 1 }, null];
    expect(describeEntry(entry(operation, { result }))).toEqual({
      label: operation === "pr.merge" ? "Merged" : label,
      detail,
      note: null,
      actor: "foreman",
      dot: "running",
      outcome: null,
    });
  });

  it("covers every kind with a detail", () => {
    for (const op of Object.keys(DETAILS)) expect(LABELS[op]).toBeDefined();
  });

  it("says when a call was held, with the reason as the note", () => {
    expect(
      describeEntry(entry("pr.merge", { outcome: "review", reason: "merge needs a person" })),
    ).toEqual({
      label: "Gate opened: Merge needs a person",
      detail: null,
      note: "merge needs a person",
      actor: "foreman",
      dot: "waiting",
      outcome: null,
    });
  });

  it("shows a refused or failed call's outcome and reason", () => {
    expect(describeEntry(entry("pr.merge", { outcome: "failed", reason: "head moved" }))).toEqual({
      label: "Merge",
      detail: null,
      note: "head moved",
      actor: "foreman",
      dot: "failed",
      outcome: "failed",
    });
    const refused = describeEntry(
      entry("spec.approve", {
        actorType: "human",
        actorId: "usr_x",
        outcome: "forbidden",
        reason: "not an approver",
      }),
    );
    expect(refused).toMatchObject({ dot: "failed", outcome: "forbidden", note: "not an approver" });
    expect(describeEntry(entry("workItem.triage", { outcome: "denied" }))).toMatchObject({
      dot: "failed",
      outcome: "denied",
    });
    expect(describeEntry(entry("run.expire", { outcome: "noop", reason: null }))).toMatchObject({
      dot: "idle",
      outcome: "noop",
      note: null,
    });
  });

  it("calls a merged PR Merged, and drops the gate check's reason on an ok call", () => {
    expect(describeEntry(entry("pr.merge", { reason: "human" }))).toMatchObject({
      label: "Merged",
      note: null,
    });
  });

  it("shows a person's decision note from the gate, over the entry's reason", () => {
    const e = entry("spec.approve", { actorType: "human", actorId: "usr_me", reason: "human" });
    expect(describeEntry(e, { me: "usr_me", gate: { note: "Looks right" } })).toMatchObject({
      actor: "you",
      dot: "done",
      note: "Looks right",
    });
    expect(describeEntry(e, { gate: { note: null } }).note).toBeNull();
    // An agent's entry never takes a gate's note.
    expect(describeEntry(entry("spec.propose"), { gate: { note: "x" } }).note).toBeNull();
  });

  it("labels actors", () => {
    expect(actorLabel({ actorType: "human", actorId: "usr_me" }, "usr_me")).toBe("you");
    expect(actorLabel({ actorType: "human", actorId: "usr_me" })).toBe("a person");
    expect(actorLabel({ actorType: "human", actorId: "usr_x" }, "usr_me")).toBe("a person");
    expect(actorLabel({ actorType: "agent", actorId: "builder" })).toBe("builder");
    expect(actorLabel({ actorType: "runner", actorId: "rnr_1" })).toBe("runner rnr_1");
    expect(actorLabel({ actorType: "system", actorId: "sweeper" })).toBe("sweeper");
  });
});

describe("the fallback", () => {
  it("uses the raw name for an unknown operation, with no detail", () => {
    expect(describeEntry(entry("thing.unknown", { result: { size: "small" } }))).toMatchObject({
      label: "thing.unknown",
      detail: null,
    });
    // Not fooled by names on Object.prototype.
    expect(describeEntry(entry("toString")).label).toBe("toString");
  });

  it.each([null, undefined, "small", 42, true, [1, 2]])(
    "gives no detail, and doesn't throw, for a result of %j",
    (result) => {
      for (const op of Object.keys(DETAILS)) {
        const d = describeEntry(entry(op, { result }));
        expect(d.label).toBe(LABELS[op]);
        expect(d.detail).toBeNull();
      }
    },
  );

  it("gives no detail when the result's fields have the wrong type", () => {
    const wrong: Record<string, unknown> = {
      "workItem.triage": { size: 3, reason: ["x"] },
      "workItem.enterStage": { stage: 3 },
      "workItem.create": { outcome: 1 },
      "pr.open": { prNumber: "42" },
      "question.ask": { questionIds: "q_1" },
      "spec.commit": { path: null },
    };
    for (const [op, result] of Object.entries(wrong)) {
      expect(describeEntry(entry(op, { result })).detail).toBeNull();
    }
  });
});
