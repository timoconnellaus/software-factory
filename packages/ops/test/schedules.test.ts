// Schedules (the Auto screen): the flow.schedule.* operations, and the cron's pass that fires due
// ones, against real D1.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type CallResult, call, runDueSchedules } from "../src/index.ts";

const d1 = env.DB;
const host = { DB: d1 };
const stamp = () => new Date().toISOString();
const at = (text: string) => Date.parse(text);

/** A person, an org of theirs, and a project there whose one status nobody owns. */
async function world() {
  const userId = `usr_${crypto.randomUUID()}`;
  const orgId = `org_${crypto.randomUUID()}`;
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
      )
      .bind(userId, `${userId}@example.com`, stamp(), stamp()),
    d1
      .prepare(
        "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Acme', ?, 'team', ?)",
      )
      .bind(orgId, orgId, stamp()),
    d1
      .prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      )
      .bind(`mem_${crypto.randomUUID()}`, orgId, userId, stamp()),
  ]);
  const op = (name: string, input: Record<string, unknown>, now?: number) =>
    call(name, { orgId, ...input }, { d1, actor: { kind: "person", id: userId }, now });
  const workflow = ok<{ id: string }>(
    await op("flow.workflow.create", {
      name: "One",
      statuses: [{ id: "todo", name: "To do", owner: { kind: "none" } }],
    }),
  );
  const project = ok<{ id: string }>(
    await op("flow.project.create", { name: "Feedback", key: "FB", workflowId: workflow.id }),
  );
  /** A schedule: every day at 02:00 UTC, saved at 01:00 on 15 November 2026. */
  const schedule = async (extra: Record<string, unknown> = {}) =>
    ok<Saved>(
      await op(
        "flow.schedule.save",
        {
          projectId: project.id,
          name: "Nightly triage",
          title: "Triage the feedback",
          body: "Sort what came in.",
          every: "day",
          atMinute: 0,
          atHour: 2,
          timeZone: "UTC",
          ...extra,
        },
        at("2026-11-15T01:00:00Z"),
      ),
    );
  const items = async () => {
    const board = ok<{ columns: { items: { title: string; createdBy: string }[] }[] }>(
      await op("flow.board.get", { projectId: project.id }),
    );
    return board.columns.flatMap((c) => c.items);
  };
  const listed = async () =>
    ok<{ schedules: Listed[] }>(await op("flow.schedule.list", {})).schedules;
  return { userId, orgId, op, project, schedule, items, listed };
}

type Saved = { id: string; nextAt: string | null };
type Listed = Saved & {
  lastAt: string | null;
  lastItemId: string | null;
  lastItemNumber: number | null;
  lastError: string | null;
  projectName: string | null;
  projectKey: string | null;
};

function ok<T = Record<string, unknown>>(r: CallResult): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

describe("the cron's pass", () => {
  it("a due schedule creates one item as its creator and moves on to its next time", async () => {
    const w = await world();
    const s = await w.schedule();
    expect(s.nextAt).toBe("2026-11-15T02:00:00.000Z");
    // Not due yet.
    await runDueSchedules(host, at("2026-11-15T01:59:00Z"));
    expect(await w.items()).toEqual([]);

    await runDueSchedules(host, at("2026-11-15T02:00:00Z"));
    const made = await w.items();
    expect(made).toEqual([
      expect.objectContaining({ title: "Triage the feedback", createdBy: w.userId }),
    ]);
    const [row] = await w.listed();
    expect(row).toMatchObject({
      nextAt: "2026-11-16T02:00:00.000Z",
      lastAt: "2026-11-15T02:00:00.000Z",
      lastItemNumber: 1,
      lastError: null,
      projectName: "Feedback",
      projectKey: "FB",
    });
  });

  it("two ticks at the same instant create one item", async () => {
    const w = await world();
    await w.schedule();
    const now = at("2026-11-15T02:00:30Z");
    await Promise.all([runDueSchedules(host, now), runDueSchedules(host, now)]);
    await runDueSchedules(host, now);
    expect(await w.items()).toHaveLength(1);
  });

  it("a schedule whose project was deleted records why and moves on", async () => {
    const w = await world();
    await w.schedule();
    await d1.prepare("DELETE FROM flow_projects WHERE id = ?").bind(w.project.id).run();
    const now = at("2026-11-15T02:01:00Z");
    await runDueSchedules(host, now);
    const [row] = await w.listed();
    expect(row).toMatchObject({
      lastError: "Its project no longer exists.",
      lastAt: "2026-11-15T02:01:00.000Z",
      lastItemId: null,
      nextAt: "2026-11-16T02:00:00.000Z",
      projectName: null,
    });
  });

  it("a schedule that is off does nothing, even with a time in the past", async () => {
    const w = await world();
    const s = await w.schedule({ enabled: false });
    expect(s.nextAt).toBeNull();
    await d1
      .prepare("UPDATE flow_schedules SET next_at = '2026-11-15T02:00:00.000Z' WHERE id = ?")
      .bind(s.id)
      .run();
    await runDueSchedules(host, at("2026-11-15T02:02:00Z"));
    expect(await w.items()).toEqual([]);
    expect((await w.listed())[0]?.lastAt).toBeNull();
  });
});

describe("flow.schedule.*", () => {
  it("runNow makes the item now and leaves the next run alone", async () => {
    const w = await world();
    const s = await w.schedule();
    const item = ok<{ title: string; number: number }>(
      await w.op("flow.schedule.runNow", { scheduleId: s.id }),
    );
    expect(item).toMatchObject({ title: "Triage the feedback", number: 1 });
    const [row] = await w.listed();
    expect(row).toMatchObject({ nextAt: s.nextAt, lastItemNumber: 1 });
  });

  it("edits, turns off and deletes; refuses a bad time zone or a week with no day", async () => {
    const w = await world();
    const s = await w.schedule();
    const weekly = ok<Saved>(
      await w.op(
        "flow.schedule.save",
        {
          scheduleId: s.id,
          projectId: w.project.id,
          name: "Weekly",
          title: "Digest",
          every: "week",
          onDay: 1,
          atHour: 9,
          atMinute: 0,
          timeZone: "Europe/London",
        },
        at("2026-11-15T01:00:00Z"),
      ),
    );
    expect(weekly).toMatchObject({ id: s.id, nextAt: "2026-11-16T09:00:00.000Z" });
    expect(await w.listed()).toHaveLength(1);
    const bad = {
      projectId: w.project.id,
      name: "x",
      title: "x",
      every: "day",
      atHour: 1,
      atMinute: 0,
    };
    expect(await w.op("flow.schedule.save", { ...bad, timeZone: "Mars/Base" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      await w.op("flow.schedule.save", { ...bad, every: "week", timeZone: "UTC" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    ok(await w.op("flow.schedule.delete", { scheduleId: s.id }));
    expect(await w.listed()).toEqual([]);
  });

  it("keeps to the org: no one else's schedules, projects or org", async () => {
    const a = await world();
    const b = await world();
    const s = await a.schedule();
    // B can't reach A's org at all.
    const asB = (name: string, input: Record<string, unknown>) =>
      call(name, { orgId: a.orgId, ...input }, { d1, actor: { kind: "person", id: b.userId } });
    for (const [name, input] of [
      ["flow.schedule.list", {}],
      ["flow.schedule.delete", { scheduleId: s.id }],
      ["flow.schedule.runNow", { scheduleId: s.id }],
    ] as const) {
      expect(await asB(name, input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    // In B's own org, A's schedule and project aren't there.
    expect(await b.op("flow.schedule.runNow", { scheduleId: s.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await b.op("flow.schedule.delete", { scheduleId: s.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await b.op("flow.schedule.save", {
        scheduleId: s.id,
        projectId: b.project.id,
        name: "x",
        title: "x",
        every: "hour",
        atMinute: 0,
        timeZone: "UTC",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await b.op("flow.schedule.save", {
        projectId: a.project.id,
        name: "x",
        title: "x",
        every: "hour",
        atMinute: 0,
        timeZone: "UTC",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await b.listed()).toEqual([]);
    expect(await a.listed()).toHaveLength(1);
  });
});
