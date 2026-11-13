// The one cron evaluator (ADR 0514, review of #197): what saves accept, how a change of schedule
// classifies (by the actual fire times), and what the firing code (g2) will use. Five fields,
// separated by ASCII spaces: minute hour day-of-month month day-of-week. Supported: `*`, numbers,
// ascending ranges `a-b`, steps `/n` on either, and comma lists. Day-of-week 0-7 (0 and 7 are
// Sunday). Cron's rule: when both day fields are restricted, a day matches if EITHER does. The
// minute is one fixed number (at most hourly). Anything else (macros like @daily, names, `L`, `W`,
// `#`, `?`, reversed ranges, other whitespace) is refused.

const BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const FIELD = ["minute", "hour", "day of month", "month", "day of week"];

export interface Cron {
  minute: number;
  hours: ReadonlySet<number>;
  /** null: `*` (every day of the month). */
  doms: ReadonlySet<number> | null;
  months: ReadonlySet<number>;
  /** null: `*`; 7 is stored as 0. */
  dows: ReadonlySet<number> | null;
}

/** The parsed cron, or why it isn't one this factory runs. */
export function parseCron(expr: string): { ok: true; cron: Cron } | { ok: false; error: string } {
  if (!/^[0-9*,/ -]+$/.test(expr))
    return { ok: false, error: "a cron is digits, *, -, /, commas and ASCII spaces only" };
  const fields = expr.trim().split(/ +/);
  if (fields.length !== 5)
    return {
      ok: false,
      error: "a cron has five fields: minute hour day-of-month month day-of-week",
    };
  const sets: (Set<number> | null)[] = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = BOUNDS[i] as [number, number];
    const f = fields[i] as string;
    if (f === "*") {
      sets.push(null);
      continue;
    }
    const out = new Set<number>();
    for (const part of f.split(",")) {
      const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
      if (!m) return { ok: false, error: `the ${FIELD[i]} isn't valid: ${part}` };
      const from = m[2] !== undefined ? Number(m[2]) : lo;
      const to = m[3] !== undefined ? Number(m[3]) : m[2] !== undefined && !m[4] ? from : hi;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (from < lo || to > hi || from > hi)
        return { ok: false, error: `the ${FIELD[i]} is out of range (${lo}-${hi}): ${part}` };
      if (from > to) return { ok: false, error: `a range runs low to high: ${part}` };
      if (step < 1) return { ok: false, error: `a step is at least 1: ${part}` };
      for (let v = from; v <= to; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    sets.push(out);
  }
  const minutes = sets[0];
  if (!minutes || minutes.size !== 1)
    return {
      ok: false,
      error: "an autopilot runs at most hourly: the minute field is one minute (0-59)",
    };
  return {
    ok: true,
    cron: {
      minute: [...minutes][0] as number,
      hours: sets[1] ?? new Set(Array.from({ length: 24 }, (_, h) => h)),
      doms: sets[2] ?? null,
      months: sets[3] ?? new Set(Array.from({ length: 12 }, (_, m) => m + 1)),
      dows: sets[4] ?? null,
    },
  };
}

/** Whether a local wall-clock time matches. */
export function cronMatches(
  c: Cron,
  t: { month: number; day: number; weekday: number; hour: number; minute: number },
): boolean {
  if (t.minute !== c.minute || !c.hours.has(t.hour) || !c.months.has(t.month)) return false;
  const dom = c.doms ? c.doms.has(t.day) : null;
  const dow = c.dows ? c.dows.has(t.weekday) : null;
  // Both restricted: either; one restricted: that one; neither: every day.
  if (dom !== null && dow !== null) return dom || dow;
  return dom ?? dow ?? true;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local wall-clock fields of a UTC instant in a time zone. */
export function localTime(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAY[p.weekday ?? ""] ?? -1,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** A fixed start for comparing schedules: the same horizon for both sides of a change. */
export const CRON_EPOCH = Date.UTC(2026, 0, 1);
export const CRON_HORIZON_DAYS = 400;

/**
 * Every time a cron fires in a time zone, as UTC milliseconds, from `from` for `days`. Steps
 * through UTC in 15-minute steps aligned to the cron's minute (every zone's offset is a multiple of
 * 15 minutes), so daylight saving's skipped and repeated hours come out as they happen.
 */
export function cronFires(
  cron: Cron,
  timeZone: string,
  from = CRON_EPOCH,
  days = CRON_HORIZON_DAYS,
): number[] {
  const out: number[] = [];
  const end = from + days * 86_400_000;
  // Every zone's offset is a multiple of 15 minutes, so the local minute is the cron's only at UTC
  // minutes congruent to it modulo 15: step from the first of those.
  const first = Math.floor(from / 900_000) * 900_000 + (cron.minute % 15) * 60_000;
  for (let ms = first < from ? first + 900_000 : first; ms < end; ms += 900_000)
    if (cronMatches(cron, localTime(ms, timeZone))) out.push(ms);
  return out;
}

/** The next time a cron fires strictly after `after` (within a year and a day), or null. */
export function nextFire(cron: Cron, timeZone: string, after: number): number | null {
  let start = Math.floor(after / 900_000) * 900_000 + (cron.minute % 15) * 60_000;
  while (start <= after) start += 900_000;
  const end = start + 367 * 86_400_000;
  for (let ms = start; ms < end; ms += 900_000)
    if (cronMatches(cron, localTime(ms, timeZone))) return ms;
  return null;
}
