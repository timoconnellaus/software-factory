// The new core's item view logic (spec 70): the timeline told as one line per move, the decision an
// item waits on and the operation each button sends, and a card's chip.
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  chipOf,
  decisionFor,
  type FlowItem,
  type FlowStatus,
  type FlowTimelineEntry,
  type Names,
} from "../src/flow.ts";

const ME = "usr_me";
const names: Names = {
  me: { id: ME, name: "Tim" },
  agents: [
    { id: "agt_writer", name: "Writer" },
    { id: "agt_editor", name: "Editor" },
  ],
};
const STATUSES: FlowStatus[] = [
  { id: "draft", name: "Draft", owner: { kind: "agent", agentId: "agt_writer" } },
  {
    id: "review",
    name: "Review",
    owner: { kind: "agent", agentId: "agt_editor" },
    needsDecision: true,
  },
  { id: "approve", name: "Approve", owner: { kind: "person", userId: ME } },
  { id: "done", name: "Published", owner: { kind: "none" } },
];

const at = "2026-11-15T10:00:00.000Z";
let seq = 0;
const e = (
  kind: FlowTimelineEntry["kind"],
  actor: FlowTimelineEntry["actor"],
  data: unknown,
): FlowTimelineEntry => ({ seq: ++seq, kind, actor, data, createdAt: at });
const writer = { kind: "agent", id: "agt_writer" } as const;
const editor = { kind: "agent", id: "agt_editor" } as const;
const me = { kind: "person", id: ME } as const;

function item(over: Partial<FlowItem>): FlowItem {
  return {
    id: "itm_1",
    orgId: "org_1",
    projectId: "prj_1",
    number: 1,
    title: "Launch post",
    body: "",
    statusId: "draft",
    waiting: { on: "nothing" },
    error: null,
    stay: 1,
    createdBy: ME,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe("the timeline", () => {
  seq = 0;
  const entries = [
    e("event", me, { type: "created" }),
    e("effect", me, { type: "entered", from: null, to: "draft", by: { kind: "system" } }),
    e("effect", me, { type: "run.start", agentId: "agt_writer", statusId: "draft", stay: 1 }),
    e("event", writer, { type: "run.ended", stay: 1, outcome: "done" }),
    e("effect", writer, { type: "entered", from: "draft", to: "review", by: writer }),
    e("effect", writer, { type: "run.start", agentId: "agt_editor", statusId: "review", stay: 2 }),
    e("comment", writer, { text: "Draft is ready." }),
    e("card", writer, { kind: "document", title: "launch.md", subtitle: "1,180 words" }),
    e("comment", me, { text: "Keep it short." }),
    e("card", editor, {
      kind: "chart",
      title: "Use cases",
      bars: [{ label: "Triage", value: 18, max: 18 }],
    }),
    e("event", editor, { type: "run.ended", stay: 2, outcome: "done" }),
    e("effect", editor, { type: "decision.ask", statusId: "review" }),
    e("event", me, { type: "decided", by: me, decision: "approve" }),
    e("effect", me, { type: "entered", from: "review", to: "approve", by: me }),
    e("effect", me, { type: "inbox.add", userId: ME, statusId: "approve", reason: "work" }),
  ];
  const rows = buildTimeline(entries, STATUSES, names);

  it("tells an event and its effects as one line per move, with what came next beneath", () => {
    const lines = rows.filter((r) => r.type === "line");
    expect(lines.map((l) => `${l.who} ${l.what} | ${l.after}`)).toEqual([
      "Tim created this item | Handed to Writer, who started a run",
      "Writer moved it from Draft to Review | Handed to Editor, who started a run",
      "Editor finished | Waiting on a decision",
      "Tim approved it from Review to Approve | Waiting on you",
    ]);
  });

  it("never shows the kernel's type names", () => {
    const text = JSON.stringify(rows);
    for (const raw of ["run.start", "run.ended", "inbox.add", "decision.ask", "entered"])
      expect(text).not.toContain(raw);
  });

  it("puts an agent's run summary, with its cards, before the move it caused", () => {
    const at = rows.findIndex((r) => r.type === "entry" && r.text === "Draft is ready.");
    const summary = rows[at];
    expect(summary).toMatchObject({ who: "Writer", by: "agent" });
    expect(summary?.type === "entry" && summary.cards.map((c) => c.title)).toEqual(["launch.md"]);
    expect(rows[at + 1]).toMatchObject({ type: "line", what: "moved it from Draft to Review" });
  });

  it("shows a person's comment as an entry, and a lone card as its author's entry", () => {
    expect(rows).toContainEqual(
      expect.objectContaining({ type: "entry", who: "Tim", by: "person", text: "Keep it short." }),
    );
    const card = rows.find((r) => r.type === "entry" && r.who === "Editor");
    expect(card?.type === "entry" && card.text).toBe(null);
    expect(card?.type === "entry" && card.cards[0]?.bars?.[0]?.label).toBe("Triage");
  });

  it("says a failed run stopped the item, once, without the error text", () => {
    seq = 0;
    const failed = buildTimeline(
      [
        e("event", writer, { type: "run.failed", stay: 1, error: "ENOSPC" }),
        e("effect", writer, { type: "stopped", statusId: "draft", error: "ENOSPC" }),
      ],
      STATUSES,
      names,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ who: "Writer", what: "couldn't finish Draft", tone: "bad" });
    expect(JSON.stringify(failed)).not.toContain("ENOSPC");
  });
});

describe("the decision", () => {
  it("is Done and Send back, through flow.item.finish, for a status the person owns", () => {
    const d = decisionFor(
      item({ statusId: "approve", waiting: { on: "person", userId: ME } }),
      STATUSES,
      ME,
    );
    expect(d?.kind).toBe("work");
    expect(d?.actions).toEqual([
      { label: "Done", op: "flow.item.finish", input: { outcome: "done" } },
      { label: "Send back", op: "flow.item.finish", input: { outcome: "rejected" } },
    ]);
    expect(d?.detail).toBe("Done moves it to Published; Send back moves it to Review.");
  });

  it("is Approve and Reject, through flow.item.decide, for an item waiting on a decision", () => {
    const d = decisionFor(item({ statusId: "review", waiting: { on: "decision" } }), STATUSES, ME);
    expect(d?.kind).toBe("decision");
    expect(d?.actions.map((a) => [a.label, a.op, a.input])).toEqual([
      ["Approve", "flow.item.decide", { decision: "approve" }],
      ["Reject", "flow.item.decide", { decision: "reject" }],
    ]);
  });

  it("is nothing for someone else's work, a run, or a stopped item", () => {
    expect(
      decisionFor(item({ waiting: { on: "person", userId: "usr_other" } }), STATUSES, ME),
    ).toBe(null);
    expect(decisionFor(item({ waiting: { on: "run", agentId: "agt_writer" } }), STATUSES, ME)).toBe(
      null,
    );
    expect(decisionFor(item({ error: "boom", waiting: { on: "decision" } }), STATUSES, ME)).toBe(
      null,
    );
  });
});

describe("a card's chip", () => {
  it("is Working on a run, Needs you on you or a decision, Stopped on an error", () => {
    expect(chipOf(item({ waiting: { on: "run", agentId: "a" } }), ME)).toBe("working");
    expect(chipOf(item({ waiting: { on: "person", userId: ME } }), ME)).toBe("needs-you");
    expect(chipOf(item({ waiting: { on: "decision" } }), ME)).toBe("needs-you");
    expect(chipOf(item({ waiting: { on: "person", userId: "usr_other" } }), ME)).toBe(null);
    expect(chipOf(item({ error: "boom" }), ME)).toBe("stopped");
  });
});
