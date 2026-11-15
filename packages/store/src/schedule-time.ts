// When a schedule next fires: a pure function of the schedule's clock and "now", worked out in the
// schedule's time zone with Intl (no time-zone library). Daylight saving, as Temporal's
// "compatible" choice: a time the clocks skip fires that much later (02:30 on the night they go
// forward is 03:30), and a time that happens twice fires at the first.

export type Every = "hour" | "day" | "weekday" | "week";

export interface Clock {
  every: Every;
  /** 0–59. */
  atMinute: number;
  /** 0–23; ignored for `hour`. */
  atHour: number | null;
  /** 0 (Sunday) to 6 (Saturday); used only for `week`. */
  onDay: number | null;
  /** An IANA name, such as "Australia/Sydney". */
  timeZone: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One formatter per zone, built once per isolate (AGENTS.md "Cloudflare cost", rule 10). */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** True if `timeZone` is an IANA name this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at instant `ms`, as if it were UTC (to the minute). */
function wallAsUtc(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
  );
}

/** The zone's offset from UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const floored = Math.floor(ms / MINUTE) * MINUTE;
  return wallAsUtc(floored, timeZone) - floored;
}

/**
 * The instant a wall-clock time (given as if it were UTC) happens in `timeZone`. Of two (clocks
 * going back), the first; of none (clocks going forward), the wall time shifted by the gap.
 */
export function wallToInstant(wall: number, timeZone: string): number {
  const before = offsetAt(wall - 12 * HOUR, timeZone);
  const after = offsetAt(wall + 12 * HOUR, timeZone);
  const fits = [wall - before, wall - after].filter((t) => offsetAt(t, timeZone) === wall - t);
  if (fits.length) return Math.min(...fits);
  return wall - before;
}

function runsOn(clock: Clock, weekday: number): boolean {
  if (clock.every === "weekday") return weekday >= 1 && weekday <= 5;
  if (clock.every === "week") return weekday === (clock.onDay ?? 1);
  return true;
}

/** The first instant strictly after `now` (ms since the epoch) at which the schedule fires. */
export function nextRunAt(clock: Clock, now: number): number {
  const wallNow = wallAsUtc(now, clock.timeZone);
  const today = Math.floor(wallNow / DAY) * DAY;
  if (clock.every === "hour") {
    // Each wall-clock hour from the current one; three days covers any skipped hours.
    const thisHour = Math.floor(wallNow / HOUR) * HOUR;
    for (let h = 0; h < 72; h++) {
      const at = wallToInstant(thisHour + h * HOUR + clock.atMinute * MINUTE, clock.timeZone);
      if (at > now) return at;
    }
  } else {
    const time = (clock.atHour ?? 0) * HOUR + clock.atMinute * MINUTE;
    // Today and the next eight days hold at least one of any day the schedule runs on.
    for (let d = 0; d < 9; d++) {
      const day = today + d * DAY;
      if (!runsOn(clock, new Date(day).getUTCDay())) continue;
      const at = wallToInstant(day + time, clock.timeZone);
      if (at > now) return at;
    }
  }
  throw new Error(`No next run for ${JSON.stringify(clock)}.`);
}
