// The new core's Auto screen (spec 70; .kim/mockups/auto-schedules.html) as the desktop app reads
// it: the flow.schedule.* operations' shapes, typed by hand, and the plain words the table shows:
// when a schedule runs ("Every day at 02:00"), when it next runs ("Tonight 02:00", "In 3 hours"),
// and what it last did.

import { z } from "zod";

// The answers' shapes are zod schemas with their types inferred (see flow.ts).

export const flowEverySchema = z.enum(["hour", "day", "weekday", "week"]);
export type FlowEvery = z.infer<typeof flowEverySchema>;

export const flowScheduleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** The item's title. */
  title: z.string(),
  body: z.string(),
  every: flowEverySchema,
  atMinute: z.number(),
  /** Null for `hour`. */
  atHour: z.number().nullable(),
  /** 0 (Sunday) to 6, for `week`. */
  onDay: z.number().nullable(),
  /** An IANA name. */
  timeZone: z.string(),
  enabled: z.boolean(),
  /** When it next runs (ISO, UTC); null while it is off. */
  nextAt: z.string().nullable(),
  lastAt: z.string().nullable(),
  lastItemId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectName: z.string().nullable(),
  projectKey: z.string().nullable(),
  lastItemNumber: z.number().nullable(),
});
export type FlowSchedule = z.infer<typeof flowScheduleSchema>;

/** What `flow.schedule.save` answers: the schedule, without the names the list joins in. */
export const flowSavedScheduleSchema = flowScheduleSchema.omit({
  projectName: true,
  projectKey: true,
  lastItemNumber: true,
});
export type FlowSavedSchedule = z.infer<typeof flowSavedScheduleSchema>;

/** What the form sends: a new schedule (no scheduleId) or a replacement. */
export interface FlowScheduleInput {
  orgId: string;
  scheduleId?: string;
  projectId: string;
  name: string;
  title: string;
  body: string;
  every: FlowEvery;
  atMinute: number;
  atHour?: number | null;
  onDay?: number | null;
  timeZone: string;
  enabled: boolean;
}

type Org = { orgId: string };
type One = Org & { scheduleId: string };

/** The operations the Auto screen calls, for packages/client's OpMap (through FlowOpMap). */
export interface FlowAutoOpMap {
  "flow.schedule.list": { input: Org; output: { schedules: FlowSchedule[] } };
  "flow.schedule.save": { input: FlowScheduleInput; output: FlowSavedSchedule };
  "flow.schedule.delete": { input: One; output: { ok: boolean } };
  "flow.schedule.runNow": { input: One; output: { id: string; number: number } };
}

export const EVERY_CHOICES: { value: FlowEvery; label: string }[] = [
  { value: "hour", label: "Every hour" },
  { value: "day", label: "Every day" },
  { value: "weekday", label: "Weekdays" },
  { value: "week", label: "Every week" },
];

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const two = (n: number) => String(n).padStart(2, "0");

/** "02:00". */
export const clockText = (hour: number, minute: number) => `${two(hour)}:${two(minute)}`;

/** This Mac's time zone: what a new schedule starts with. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * When it runs, in plain words: "Every day at 02:00", "Weekdays at 09:00", "Mondays at 09:00",
 * "Every hour at :15". The zone is named only when it isn't the viewer's.
 */
export function everyText(
  s: Pick<FlowSchedule, "every" | "atMinute" | "atHour" | "onDay" | "timeZone">,
  viewerZone: string = viewerTimeZone(),
): string {
  const at = clockText(s.atHour ?? 0, s.atMinute);
  const text =
    s.every === "hour"
      ? `Every hour at :${two(s.atMinute)}`
      : s.every === "day"
        ? `Every day at ${at}`
        : s.every === "weekday"
          ? `Weekdays at ${at}`
          : `${DAY_NAMES[s.onDay ?? 1] ?? "Monday"}s at ${at}`;
  return s.timeZone === viewerZone ? text : `${text} (${s.timeZone})`;
}

interface Wall {
  /** The calendar day, as a UTC midnight in ms. */
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function wall(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  for (const p of format.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const day = Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1);
  return {
    day,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    weekday: new Date(day).getUTCDay(),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When it next runs, in the schedule's zone: "In 25 min", "In 3 hours", "Today 14:00", "Tonight
 * 02:00" (late tonight or before 06:00 tomorrow), "Tomorrow 09:00", "Mon 09:00", "30 Nov 09:00".
 * "Off" when it is off; "Due" when it is about to run.
 */
export function nextText(
  s: Pick<FlowSchedule, "nextAt" | "enabled" | "timeZone">,
  now: number = Date.now(),
): string {
  if (!s.enabled || !s.nextAt) return "Off";
  const at = Date.parse(s.nextAt);
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "Due";
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 4 * 60) {
    const hours = Math.round(minutes / 60);
    return hours === 1 ? "In an hour" : `In ${hours} hours`;
  }
  const then = wall(at, s.timeZone);
  const today = wall(now, s.timeZone);
  const days = Math.round((then.day - today.day) / 86_400_000);
  const time = clockText(then.hour, then.minute);
  if ((days === 0 && then.hour >= 18) || (days === 1 && then.hour < 6)) return `Tonight ${time}`;
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${(DAY_NAMES[then.weekday] ?? "").slice(0, 3)} ${time}`;
  return `${new Date(then.day).getUTCDate()} ${MONTHS[new Date(then.day).getUTCMonth()]} ${time}`;
}

/** What it last did: the item it made, why it failed, or nothing yet. */
export type LastRun =
  | { kind: "item"; itemId: string; projectId: string; key: string }
  | { kind: "error"; text: string }
  | { kind: "none" };

export function lastRun(s: FlowSchedule): LastRun {
  if (s.lastError) return { kind: "error", text: s.lastError };
  if (s.lastItemId) {
    const key =
      s.projectKey && s.lastItemNumber !== null ? `${s.projectKey}-${s.lastItemNumber}` : "An item";
    return { kind: "item", itemId: s.lastItemId, projectId: s.projectId, key };
  }
  return { kind: "none" };
}

/** The form's fields. Time is "HH:MM" as typed. */
export interface ScheduleDraft {
  name: string;
  projectId: string;
  title: string;
  body: string;
  every: FlowEvery;
  time: string;
  onDay: number;
  timeZone: string;
  enabled: boolean;
}

export function draftOf(s: FlowSchedule | null, projectId: string, zone: string): ScheduleDraft {
  if (!s) {
    return {
      name: "",
      projectId,
      title: "",
      body: "",
      every: "day",
      time: "09:00",
      onDay: 1,
      timeZone: zone,
      enabled: true,
    };
  }
  return {
    name: s.name,
    projectId: s.projectId,
    title: s.title,
    body: s.body,
    every: s.every,
    time: clockText(s.atHour ?? 0, s.atMinute),
    onDay: s.onDay ?? 1,
    timeZone: s.timeZone,
    enabled: s.enabled,
  };
}

/** "09:30" as hour and minute; "every hour" reads only the minute. Null if it isn't a time. */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** What a draft sends, or why it can't be sent yet. */
export function toInput(
  orgId: string,
  draft: ScheduleDraft,
  scheduleId?: string,
): FlowScheduleInput | { problem: string } {
  if (!draft.name.trim()) return { problem: "Give it a name." };
  if (!draft.projectId) return { problem: "Choose a project." };
  if (!draft.title.trim()) return { problem: "Say what the item is called." };
  const time = parseTime(draft.time);
  if (!time) return { problem: "Write the time as HH:MM, such as 09:00." };
  return {
    orgId,
    ...(scheduleId ? { scheduleId } : {}),
    projectId: draft.projectId,
    name: draft.name.trim(),
    title: draft.title.trim(),
    body: draft.body,
    every: draft.every,
    atMinute: time.minute,
    atHour: draft.every === "hour" ? null : time.hour,
    onDay: draft.every === "week" ? draft.onDay : null,
    timeZone: draft.timeZone,
    enabled: draft.enabled,
  };
}
