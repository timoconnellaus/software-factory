// The Planning tab (spec 20): its live stream route and the logic behind the panes.
import { describe, expect, it } from "vitest";
import { runnerLabel } from "#/components/runner-health";
import {
  answerText,
  blocks,
  chipTag,
  gateSummary,
  isChanged,
  markTags,
  type PlanningView,
  sessionPill,
} from "#/lib/planning";
import type { EngineRpc } from "#/server/engine";
import { handlePlanningLive, LIVE_PATH } from "#/server/planning-live";
import { recordingEngine, signIn, testEnv } from "./helpers.ts";

const ITEM = `wi_${"a".repeat(32)}`;

describe("the Planning tab's live stream", () => {
  it("proxies the engine's Server-Sent Events as the signed-in person, and nobody else", async () => {
    const asked: { workItemId: string; actor: unknown }[] = [];
    const { engine } = recordingEngine();
    const live: EngineRpc = {
      ...engine,
      async planningStream(workItemId, options) {
        asked.push({ workItemId, actor: options.actor });
        if (workItemId !== ITEM) {
          return { ok: false, error: { code: "not_found", message: "no work item" } };
        }
        const body = new TextEncoder().encode('event: changed\ndata: {"seq":1}\n\n');
        return {
          ok: true,
          stream: new ReadableStream({
            start(c) {
              c.enqueue(body);
              c.close();
            },
          }),
        };
      },
    };
    const appEnv = testEnv(live);
    const url = `http://localhost/api/work/${ITEM}/planning/live`;
    expect(LIVE_PATH.exec(new URL(url).pathname)?.[1]).toBe(ITEM);
    const anonymous = await handlePlanningLive(appEnv, new Request(url), ITEM);
    expect(anonymous.status).toBe(401);
    const { user, headers } = await signIn(appEnv, "timoconnellaus");
    const ok = await handlePlanningLive(appEnv, new Request(url, { headers }), ITEM);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    expect(await ok.text()).toContain("event: changed");
    expect(asked[0]).toEqual({ workItemId: ITEM, actor: { type: "human", id: user.id } });
    const other = `wi_${"b".repeat(32)}`;
    const missing = await handlePlanningLive(appEnv, new Request(url, { headers }), other);
    expect(missing.status).toBe(404);
  });
});

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
