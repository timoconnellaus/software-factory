// The Planning tab's panes (spec 20, layout A): the logic behind them, shared by both front ends.
import { describe, expect, it } from "vitest";
import {
  answerText,
  blocks,
  chipTag,
  gateSummary,
  isChanged,
  markTags,
  type PlanningView,
  sessionPill,
} from "../src/planning.ts";
import { runnerLabel } from "../src/runners.ts";

const session = (over: Partial<NonNullable<PlanningView["session"]>> = {}) => ({
  id: "ps_1",
  status: "idle",
  activity: null,
  idleSince: null,
  agentSeenAt: null,
  atGate: false,
  ready: false,
  yieldRequested: false,
  focusedQuestionId: null,
  runner: { id: "r_1", name: "mac-mini", online: true, lastSeenAt: null },
  waitingForRunner: false,
  createdAt: "2026-11-12T00:00:00.000Z",
  ...over,
});

describe("the planning panes", () => {
  it("shows the session pill in each state (mockup planning-session-states)", () => {
    expect(
      sessionPill(session({ status: "working", activity: "revising the spec" }), 1),
    ).toMatchObject({
      state: "attached",
      label: "Planning agent · attached · mac-mini",
      detail: "Revising the spec…",
    });
    expect(sessionPill(session(), 0)?.label).toBe(
      "Planning agent · waiting for answers · mac-mini",
    );
    expect(sessionPill(session({ status: "yielded" }), 0)?.state).toBe("paused");
    expect(sessionPill(session({ waitingForRunner: true }), 0)).toMatchObject({
      state: "waiting",
      label: "Waiting for mac-mini",
    });
    expect(sessionPill(session({ atGate: true }), 0)?.state).toBe("gate");
    expect(sessionPill(null, 0)).toBeNull();
  });

  it("turns provenance tags into chips, outside code", () => {
    const md = "Export CSV [request] and dates [assumption].\n`[Q1] stays code`\n```\n[repo]\n```";
    const marked = markTags(md);
    expect(marked).toContain("`⟦request⟧`");
    expect(marked).toContain("`⟦assumption⟧`");
    expect(marked).toContain("`[Q1] stays code`");
    expect(marked).toContain("```\n[repo]\n```");
    expect(chipTag("⟦Q12⟧")).toBe("Q12");
    expect(chipTag("plain code")).toBeNull();
  });

  it("highlights what changed since the previous revision, ignoring tags and list marks", () => {
    const previous = blocks("## Goal\n- Export CSV [request]\n- Dates ISO [assumption]");
    expect(isChanged("Export CSV ⟦request⟧", previous)).toBe(false);
    expect(isChanged("Dates ISO in the org's time zone ⟦Q1⟧", previous)).toBe(true);
    expect(isChanged("anything", null)).toBe(false);
  });

  it("counts the gate bar and joins multiple-choice answers like defaults", () => {
    const q = (status: string, acceptedDefault: boolean) =>
      ({ status, acceptedDefault }) as PlanningView["questions"][number];
    const summary = gateSummary({
      questions: [q("answered", true), q("answered", false), q("open", false)],
      spec: {
        assumptions: ["a", "b"],
        coverage: [{ status: "clear" }, { status: "partial" }],
      } as unknown as PlanningView["spec"],
    });
    expect(summary).toBe("2 of 3 answered · 1 default accepted · 2 assumptions · coverage 1/2");
    expect(answerText("multiple-choice", ["Visible", " Custom "])).toBe("Visible, Custom");
    expect(answerText("single-choice", ["A", "B"])).toBe("A");
  });

  it("shows both pools on the runner health line (ADR 0301)", () => {
    const r = {
      id: "r",
      name: "mac-mini",
      state: "busy" as const,
      inUse: 1,
      max: 2,
      light: { inUse: 2, max: 6 },
      rateLimitedUntil: null,
      lastSeenAt: null,
      update: null,
    };
    expect(runnerLabel(r)).toBe("busy · heavy 1/2 · light 2/6");
    expect(runnerLabel({ ...r, state: "online" })).toBe("online · heavy 1/2 · light 2/6");
  });
});
