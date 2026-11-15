// An org's schedules (the Auto screen): each creates an item in a project on a clock. This module
// reads and writes flow_schedules; firing one (creating the item with the plugins' hooks) is in
// packages/ops, which the engine's minute cron calls.
import { sql } from "kysely";
import { flowDb, iso, newId, StoreError } from "./db.ts";
import { type Clock, type Every, nextRunAt } from "./schedule-time.ts";
import type { FlowSchedulesTable } from "./schema.ts";

export interface Schedule {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  /** The item's title. */
  title: string;
  /** The item's body. */
  body: string;
  every: Every;
  atMinute: number;
  atHour: number | null;
  onDay: number | null;
  timeZone: string;
  enabled: boolean;
  /** When it next fires (ISO, UTC); null while it is off. */
  nextAt: string | null;
  lastAt: string | null;
  lastItemId: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A schedule as the list shows it: with its project, and the item it last made. */
export interface ListedSchedule extends Schedule {
  projectName: string | null;
  projectKey: string | null;
  lastItemNumber: number | null;
}

/** The most schedules a list returns (an org has a handful). */
export const SCHEDULE_LIMIT = 200;

export function toSchedule(row: FlowSchedulesTable): Schedule {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    name: row.name,
    title: row.title,
    body: row.body,
    every: row.every,
    atMinute: row.at_minute,
    atHour: row.at_hour,
    onDay: row.on_day,
    timeZone: row.time_zone,
    enabled: row.enabled === 1,
    nextAt: row.next_at,
    lastAt: row.last_at,
    lastItemId: row.last_item_id,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The schedule's clock, normalised: no hour for `hour`, a day only for `week`. */
export function clockOf(s: Clock): Clock {
  return {
    every: s.every,
    atMinute: s.atMinute,
    atHour: s.every === "hour" ? null : (s.atHour ?? 0),
    onDay: s.every === "week" ? (s.onDay ?? 1) : null,
    timeZone: s.timeZone,
  };
}

export interface ScheduleInput extends Clock {
  orgId: string;
  /** Omitted: a new schedule. */
  scheduleId?: string;
  projectId: string;
  name: string;
  title: string;
  body: string;
  enabled: boolean;
  createdBy: string;
}

/**
 * Creates a schedule, or replaces one of the org's. Its next run is worked out again from `now`
 * (null while it is off); what it last did is kept.
 */
export async function saveSchedule(
  d1: D1Database,
  input: ScheduleInput,
  now: number,
): Promise<Schedule> {
  const db = flowDb(d1);
  const clock = clockOf(input);
  const fields = {
    project_id: input.projectId,
    name: input.name,
    title: input.title,
    body: input.body,
    every: clock.every,
    at_minute: clock.atMinute,
    at_hour: clock.atHour,
    on_day: clock.onDay,
    time_zone: clock.timeZone,
    enabled: input.enabled ? 1 : 0,
    next_at: input.enabled ? iso(nextRunAt(clock, now)) : null,
    updated_at: iso(now),
  };
  if (input.scheduleId === undefined) {
    const row = await db
      .insertInto("flow_schedules")
      .values({
        ...fields,
        id: newId("fsch_"),
        org_id: input.orgId,
        last_at: null,
        last_item_id: null,
        last_error: null,
        created_by: input.createdBy,
        created_at: iso(now),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSchedule(row);
  }
  const row = await db
    .updateTable("flow_schedules")
    .set(fields)
    .where("id", "=", input.scheduleId)
    .where("org_id", "=", input.orgId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No schedule ${input.scheduleId}.`);
  return toSchedule(row);
}

export async function getSchedule(
  d1: D1Database,
  orgId: string,
  id: string,
): Promise<Schedule | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_schedules")
    .selectAll()
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return row ? toSchedule(row) : null;
}

/** The org's schedules by name, each with its project's name and key and its last item's number. */
export async function listSchedules(d1: D1Database, orgId: string): Promise<ListedSchedule[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_schedules as s")
    .leftJoin("flow_projects as p", "p.id", "s.project_id")
    .leftJoin("flow_items as i", "i.id", "s.last_item_id")
    .selectAll("s")
    .select(["p.name as project_name", "p.key as project_key", "i.number as last_item_number"])
    .where("s.org_id", "=", orgId)
    .orderBy("s.name")
    .limit(SCHEDULE_LIMIT)
    .execute();
  return rows.map((r) => ({
    ...toSchedule(r),
    projectName: r.project_name,
    projectKey: r.project_key,
    lastItemNumber: r.last_item_number,
  }));
}

export async function deleteSchedule(d1: D1Database, orgId: string, id: string): Promise<void> {
  const result = await flowDb(d1)
    .deleteFrom("flow_schedules")
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!result.numDeletedRows) throw new StoreError("not_found", `No schedule ${id}.`);
}

/** Schedules that are on and due at `now`, the most overdue first: the cron's read. */
export async function dueSchedules(
  d1: D1Database,
  now: number,
  limit: number,
): Promise<Schedule[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_schedules")
    .selectAll()
    // Written as the index's WHERE, literally, so SQLite uses the partial flow_schedules_due_idx.
    .where(sql<boolean>`enabled = 1`)
    .where("next_at", "<=", iso(now))
    .orderBy("next_at")
    .limit(limit)
    .execute();
  return rows.map(toSchedule);
}

/**
 * Takes a due schedule's firing: moves `next_at` on from the value it was read with. False if
 * another tick took it first (or it was edited or turned off meanwhile): then don't fire it.
 */
export async function claimSchedule(
  d1: D1Database,
  schedule: Schedule,
  now: number,
): Promise<boolean> {
  if (schedule.nextAt === null) return false;
  const result = await flowDb(d1)
    .updateTable("flow_schedules")
    .set({ next_at: iso(nextRunAt(clockOf(schedule), now)) })
    .where("id", "=", schedule.id)
    .where("enabled", "=", 1)
    .where("next_at", "=", schedule.nextAt)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/** What a firing did: the item it made, or why it failed. Leaves `next_at` alone. */
export async function recordFiring(
  d1: D1Database,
  id: string,
  at: number,
  outcome: { itemId: string } | { error: string },
): Promise<void> {
  await flowDb(d1)
    .updateTable("flow_schedules")
    .set(
      "itemId" in outcome
        ? { last_at: iso(at), last_item_id: outcome.itemId, last_error: null }
        : { last_at: iso(at), last_error: outcome.error },
    )
    .where("id", "=", id)
    .execute();
}
