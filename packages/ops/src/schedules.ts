// flow.schedule.*: an org's schedules (the Auto screen), and firing them. A schedule creates an item
// in a project on a clock; the item then goes through its project's workflow like any other, with
// the org's plugins' `entered` hooks. The engine's minute cron calls runDueSchedules.
import { createItemWithHooks, type PluginHostEnv } from "@software-factory/plugins";
import {
  claimSchedule,
  deleteSchedule,
  dueSchedules,
  getSchedule,
  type Item,
  isTimeZone,
  listSchedules,
  recordFiring,
  type Schedule,
  StoreError,
  saveSchedule,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, id, OpError, orgId, personOf } from "./operation.ts";

/** The most schedules one cron tick fires. */
export const DUE_PER_TICK = 20;

/** Why a firing failed, in words for the Auto screen. */
function messageOf(error: unknown): string {
  if (error instanceof StoreError && error.code === "not_found") {
    return "Its project no longer exists.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Creates the schedule's item as its creator and records what happened. Never throws. */
export async function fireSchedule(
  host: PluginHostEnv,
  schedule: Schedule,
  now: number,
): Promise<{ item: Item } | { error: string }> {
  let outcome: { item: Item } | { error: string };
  try {
    const item = await createItemWithHooks(host, {
      orgId: schedule.orgId,
      projectId: schedule.projectId,
      title: schedule.title,
      body: schedule.body,
      createdBy: schedule.createdBy,
    });
    outcome = { item };
  } catch (error) {
    outcome = { error: messageOf(error) };
  }
  await recordFiring(
    host.DB,
    schedule.id,
    now,
    "item" in outcome ? { itemId: outcome.item.id } : outcome,
  ).catch((error) => console.error("recording a schedule's firing failed", error));
  return outcome;
}

/**
 * The cron's pass: at most DUE_PER_TICK due schedules, each moved on to its next time before it
 * fires (so two ticks can't both fire it, and a broken one fires once a period, not every tick).
 */
export async function runDueSchedules(
  host: PluginHostEnv,
  now: number,
): Promise<{ fired: number; failed: number }> {
  let fired = 0;
  let failed = 0;
  for (const schedule of await dueSchedules(host.DB, now, DUE_PER_TICK)) {
    try {
      if (!(await claimSchedule(host.DB, schedule, now))) continue;
      const outcome = await fireSchedule(host, schedule, now);
      if ("item" in outcome) fired++;
      else failed++;
    } catch (error) {
      failed++;
      console.error(`schedule ${schedule.id} failed`, error);
    }
  }
  return { fired, failed };
}

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, { message: "Not a time zone this engine knows (an IANA name)." });

export const scheduleOps = [
  defineOperation({
    name: "flow.schedule.list",
    description:
      "The org's schedules by name: each makes an item in a project on a clock. With the project's name and key, when it next runs (nextAt, UTC), and what it last did: the item it made (lastItemId, lastItemNumber) or why it failed (lastError).",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ schedules: await listSchedules(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.schedule.save",
    description:
      "Create a schedule (no scheduleId) or replace one. It creates an item titled `title` in `projectId` every hour at :atMinute, every day / weekday (Mon–Fri) at atHour:atMinute, or every week on onDay (0 Sunday to 6 Saturday) at that time, in timeZone (an IANA name). Its next run is worked out again when saved.",
    risk: "write",
    input: z.object({
      orgId,
      scheduleId: id.optional(),
      projectId: id,
      name: z.string().trim().min(1).max(100),
      title: z.string().trim().min(1).max(300),
      body: z.string().max(100_000).default(""),
      every: z.enum(["hour", "day", "weekday", "week"]),
      atMinute: z.number().int().min(0).max(59),
      atHour: z.number().int().min(0).max(23).nullable().optional(),
      onDay: z.number().int().min(0).max(6).nullable().optional(),
      timeZone,
      enabled: z.boolean().default(true),
    }),
    handler: (input, ctx) => {
      if (input.every !== "hour" && input.atHour == null) {
        throw new OpError("invalid_input", "atHour: a daily, weekday or weekly schedule needs it.");
      }
      if (input.every === "week" && input.onDay == null) {
        throw new OpError("invalid_input", "onDay: a weekly schedule needs it.");
      }
      return saveSchedule(
        ctx.d1,
        {
          orgId: ctx.orgId,
          ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
          projectId: input.projectId,
          name: input.name,
          title: input.title,
          body: input.body,
          every: input.every,
          atMinute: input.atMinute,
          atHour: input.atHour ?? null,
          onDay: input.onDay ?? null,
          timeZone: input.timeZone,
          enabled: input.enabled,
          createdBy: personOf(ctx.actor),
        },
        ctx.now,
      );
    },
  }),
  defineOperation({
    name: "flow.schedule.delete",
    description: "Delete a schedule. The items it made stay.",
    risk: "write",
    input: z.object({ orgId, scheduleId: id }),
    handler: async (input, ctx) => {
      await deleteSchedule(ctx.d1, ctx.orgId, input.scheduleId);
      return { ok: true };
    },
  }),
  defineOperation({
    name: "flow.schedule.runNow",
    description:
      "Create the schedule's item now, as its next run would, without changing when it next runs. Answers the item, or the error (also recorded as the schedule's lastError).",
    risk: "write",
    input: z.object({ orgId, scheduleId: id }),
    handler: async (input, ctx) => {
      const schedule = await getSchedule(ctx.d1, ctx.orgId, input.scheduleId);
      if (!schedule) throw new OpError("not_found", `No schedule ${input.scheduleId}.`);
      const outcome = await fireSchedule(ctx.host, schedule, ctx.now);
      if ("error" in outcome) throw new OpError("conflict", outcome.error);
      return outcome.item;
    },
  }),
];
