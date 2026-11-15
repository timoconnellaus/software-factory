// Schedules: when one next fires (daylight saving, week boundaries, weekdays), and the store's
// reads and writes of flow_schedules. Firing (the cron) is tested in packages/ops.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Clock,
  claimSchedule,
  createProject,
  createWorkflow,
  deleteSchedule,
  dueSchedules,
  getSchedule,
  isTimeZone,
  listSchedules,
  nextRunAt,
  saveSchedule,
} from "../src/index.ts";

const d1 = env.DB;
const at = (text: string) => Date.parse(text);
const next = (clock: Partial<Clock>, now: string) =>
  new Date(
    nextRunAt(
      { every: "day", atMinute: 0, atHour: 0, onDay: null, timeZone: "UTC", ...clock },
      at(now),
    ),
  ).toISOString();

describe("nextRunAt", () => {
  it("fires later today, or tomorrow once today's time has passed", () => {
    expect(next({ atHour: 2 }, "2026-11-15T01:00:00Z")).toBe("2026-11-15T02:00:00.000Z");
    expect(next({ atHour: 2 }, "2026-11-15T02:00:00Z")).toBe("2026-11-16T02:00:00.000Z");
  });

  it("works in the schedule's time zone", () => {
    // 09:00 in Sydney (UTC+11 in November) is 22:00 UTC the day before.
    expect(next({ atHour: 9, timeZone: "Australia/Sydney" }, "2026-11-15T12:00:00Z")).toBe(
      "2026-11-15T22:00:00.000Z",
    );
    // Kolkata is UTC+05:30: :15 past each hour there is :45 past in UTC.
    expect(
      next({ every: "hour", atMinute: 15, timeZone: "Asia/Kolkata" }, "2026-11-15T10:50:00Z"),
    ).toBe("2026-11-15T11:45:00.000Z");
  });

  it("fires every hour at its minute", () => {
    expect(next({ every: "hour", atMinute: 15 }, "2026-11-15T10:20:00Z")).toBe(
      "2026-11-15T11:15:00.000Z",
    );
    expect(next({ every: "hour", atMinute: 15 }, "2026-11-15T23:30:00Z")).toBe(
      "2026-11-16T00:15:00.000Z",
    );
  });

  it("fires an hour late on the night the clocks skip its time", () => {
    // Sydney goes from 02:00 AEST (+10) to 03:00 AEDT (+11) on Sunday 4 October 2026: 02:30
    // doesn't happen, so it fires at 03:30 AEDT (16:30 UTC on the 3rd).
    const clock = { atHour: 2, atMinute: 30, timeZone: "Australia/Sydney" };
    expect(next(clock, "2026-10-03T02:00:00Z")).toBe("2026-10-03T16:30:00.000Z");
    // And the night after, at 02:30 AEDT again.
    expect(next(clock, "2026-10-03T16:30:00Z")).toBe("2026-10-04T15:30:00.000Z");
  });

  it("fires once on the night the clocks go back over its time", () => {
    // Sydney goes from 03:00 AEDT back to 02:00 AEST on Sunday 5 April 2026: 02:30 happens twice.
    const clock = { atHour: 2, atMinute: 30, timeZone: "Australia/Sydney" };
    expect(next(clock, "2026-04-04T12:00:00Z")).toBe("2026-04-04T15:30:00.000Z");
    expect(next(clock, "2026-04-04T15:30:00Z")).toBe("2026-04-05T16:30:00.000Z");
  });

  it("crosses a week boundary for a weekly schedule", () => {
    const monday = { every: "week" as const, onDay: 1, atHour: 9 };
    // Monday 16 November 2026, an hour after: next Monday.
    expect(next(monday, "2026-11-16T10:00:00Z")).toBe("2026-11-23T09:00:00.000Z");
    // Saturday: the coming Monday.
    expect(next(monday, "2026-11-14T10:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
    // Sunday 09:00 the week's last day (onDay 0) from the Sunday after it ran.
    expect(next({ ...monday, onDay: 0 }, "2026-11-15T09:00:00Z")).toBe("2026-11-22T09:00:00.000Z");
  });

  it("skips the weekend for a weekday schedule", () => {
    const weekdays = { every: "weekday" as const, atHour: 9, timeZone: "Europe/London" };
    // Friday 13 November 2026 after 09:00: Monday.
    expect(next(weekdays, "2026-11-13T10:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
    // Saturday: Monday.
    expect(next(weekdays, "2026-11-14T08:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
    // Monday before 09:00: that morning.
    expect(next(weekdays, "2026-11-16T08:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
  });

  it("knows a time zone from a typo", () => {
    expect(isTimeZone("Australia/Sydney")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});

async function project(orgId: string) {
  const wf = await createWorkflow(d1, orgId, {
    name: "One",
    statuses: [{ id: "todo", name: "To do", owner: { kind: "none" } }],
  });
  if (!wf.ok) throw new Error("workflow refused");
  return createProject(d1, { orgId, name: "Feedback", key: "FB", workflowId: wf.workflow.id });
}

describe("the schedules table", () => {
  it("saves, lists, claims once and deletes, inside one org", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const p = await project(orgId);
    const now = at("2026-11-15T01:00:00Z");
    const base = {
      orgId,
      projectId: p.id,
      name: "Nightly triage",
      title: "Triage",
      body: "",
      every: "day" as const,
      atMinute: 0,
      atHour: 2,
      onDay: 5,
      timeZone: "UTC",
      enabled: true,
      createdBy: "sam",
    };
    const saved = await saveSchedule(d1, base, now);
    expect(saved.nextAt).toBe("2026-11-15T02:00:00.000Z");
    // A day only for a weekly schedule.
    expect(saved.onDay).toBeNull();
    const [listed] = await listSchedules(d1, orgId);
    expect(listed).toMatchObject({ name: "Nightly triage", projectName: "Feedback" });
    expect(await listSchedules(d1, `org_${crypto.randomUUID()}`)).toEqual([]);
    expect(await getSchedule(d1, "org_other", saved.id)).toBeNull();

    const due = (await dueSchedules(d1, at("2026-11-15T02:00:00Z"), 100)).filter(
      (s) => s.id === saved.id,
    );
    expect(due).toHaveLength(1);
    const [s] = due;
    if (!s) throw new Error("not due");
    expect(await claimSchedule(d1, s, at("2026-11-15T02:00:00Z"))).toBe(true);
    expect(await claimSchedule(d1, s, at("2026-11-15T02:00:00Z"))).toBe(false);
    expect((await getSchedule(d1, orgId, saved.id))?.nextAt).toBe("2026-11-16T02:00:00.000Z");

    const off = await saveSchedule(d1, { ...base, scheduleId: saved.id, enabled: false }, now);
    expect(off.nextAt).toBeNull();
    await expect(
      saveSchedule(d1, { ...base, orgId: "org_other", scheduleId: saved.id }, now),
    ).rejects.toThrow(/No schedule/);
    await expect(deleteSchedule(d1, "org_other", saved.id)).rejects.toThrow(/No schedule/);
    await deleteSchedule(d1, orgId, saved.id);
    expect(await listSchedules(d1, orgId)).toEqual([]);
  });
});
