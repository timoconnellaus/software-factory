// Auto's plain words (flow-auto.ts): when a schedule runs, when it next runs, what it last did, and
// what the form sends.
import { describe, expect, it } from "vitest";
import {
  draftOf,
  everyText,
  type FlowSchedule,
  lastRun,
  nextText,
  parseTime,
  toInput,
} from "../src/flow-auto.ts";

const s = (over: Partial<FlowSchedule> = {}): FlowSchedule => ({
  id: "fsch_1",
  orgId: "org_1",
  projectId: "fprj_1",
  name: "Nightly triage",
  title: "Triage",
  body: "",
  every: "day",
  atMinute: 0,
  atHour: 2,
  onDay: null,
  timeZone: "UTC",
  enabled: true,
  nextAt: null,
  lastAt: null,
  lastItemId: null,
  lastError: null,
  createdBy: "usr_1",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  projectName: "Feedback",
  projectKey: "FB",
  lastItemNumber: null,
  ...over,
});

describe("everyText", () => {
  it("says when it runs in plain words", () => {
    expect(everyText(s(), "UTC")).toBe("Every day at 02:00");
    expect(everyText(s({ every: "weekday", atHour: 9 }), "UTC")).toBe("Weekdays at 09:00");
    expect(everyText(s({ every: "week", onDay: 1, atHour: 9 }), "UTC")).toBe("Mondays at 09:00");
    expect(everyText(s({ every: "hour", atMinute: 15, atHour: null }), "UTC")).toBe(
      "Every hour at :15",
    );
  });

  it("names the zone only when it isn't the viewer's", () => {
    expect(everyText(s({ timeZone: "Europe/London" }), "Australia/Sydney")).toBe(
      "Every day at 02:00 (Europe/London)",
    );
  });
});

describe("nextText", () => {
  const now = Date.parse("2026-11-16T20:00:00Z"); // a Monday evening, UTC
  const next = (iso: string | null, over: Partial<FlowSchedule> = {}) =>
    nextText(s({ nextAt: iso, ...over }), now);

  it("counts down when it's close", () => {
    expect(next("2026-11-16T20:00:20Z")).toBe("Due");
    expect(next("2026-11-16T20:25:00Z")).toBe("In 25 min");
    expect(next("2026-11-16T21:00:00Z")).toBe("In an hour");
    expect(next("2026-11-16T23:00:00Z")).toBe("In 3 hours");
  });

  it("names the night, the day and the weekday after that", () => {
    expect(next("2026-11-17T02:00:00Z")).toBe("Tonight 02:00");
    expect(next("2026-11-17T09:00:00Z")).toBe("Tomorrow 09:00");
    expect(next("2026-11-20T17:00:00Z")).toBe("Fri 17:00");
    expect(next("2026-11-30T09:00:00Z")).toBe("30 Nov 09:00");
    // In the schedule's zone: now is Tuesday 07:00 in Sydney, so 22:00 UTC on Tuesday is
    // Wednesday 09:00 there.
    expect(next("2026-11-17T22:00:00Z")).toBe("Tomorrow 22:00");
    expect(next("2026-11-17T22:00:00Z", { timeZone: "Australia/Sydney" })).toBe("Tomorrow 09:00");
  });

  it("is Off when it's off", () => {
    expect(next(null)).toBe("Off");
    expect(next("2026-11-17T02:00:00Z", { enabled: false })).toBe("Off");
  });
});

describe("lastRun", () => {
  it("is the item it made, its error, or nothing", () => {
    expect(lastRun(s({ lastItemId: "fitm_1", lastItemNumber: 12 }))).toEqual({
      kind: "item",
      itemId: "fitm_1",
      projectId: "fprj_1",
      key: "FB-12",
    });
    expect(
      lastRun(s({ lastItemId: "fitm_1", lastError: "Its project no longer exists." })),
    ).toEqual({ kind: "error", text: "Its project no longer exists." });
    expect(lastRun(s())).toEqual({ kind: "none" });
  });
});

describe("the form", () => {
  it("reads a time, and sends only what the choice needs", () => {
    expect(parseTime("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTime("24:00")).toBeNull();
    const draft = { ...draftOf(null, "fprj_1", "Europe/London"), name: "Digest", title: "Write" };
    expect(toInput("org_1", { ...draft, every: "week", onDay: 5, time: "17:00" })).toEqual({
      orgId: "org_1",
      projectId: "fprj_1",
      name: "Digest",
      title: "Write",
      body: "",
      every: "week",
      atMinute: 0,
      atHour: 17,
      onDay: 5,
      timeZone: "Europe/London",
      enabled: true,
    });
    expect(toInput("org_1", { ...draft, every: "hour", time: "00:15" }, "fsch_1")).toMatchObject({
      scheduleId: "fsch_1",
      atHour: null,
      atMinute: 15,
      onDay: null,
    });
    expect(toInput("org_1", { ...draft, name: " " })).toEqual({ problem: "Give it a name." });
  });

  it("starts an edit from the schedule", () => {
    expect(
      draftOf(s({ every: "week", onDay: 3, atHour: 7, atMinute: 5 }), "x", "UTC"),
    ).toMatchObject({
      every: "week",
      onDay: 3,
      time: "07:05",
      timeZone: "UTC",
      projectId: "fprj_1",
    });
  });
});
