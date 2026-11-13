// The one cron evaluator (ADR 0514, review of #197): what saves accept, how a change of schedule
// classifies (by the actual fire times), and what the firing code (g2) will use. Five fields,
// separated by ASCII spaces: minute hour day-of-month month day-of-week. Supported: `*`, numbers,
// ascending ranges `a-b`, steps `/n` on either, and comma lists. Day-of-week 0-7 (0 and 7 are
// Sunday). Cron's rule: when both day fields are restricted, a day matches if EITHER does. The
// minute is one fixed number (at most hourly). Anything else (macros like @daily, names, `L`, `W`,
// `#`, `?`, reversed ranges, other whitespace) is refused.
// Only a bare `*` leaves a day field unrestricted: a stepped `*/n` counts as restricted (so `*/2`
// with a day of week is an OR), unlike Vixie cron, which treats any field starting with `*` as
// unrestricted (review of #197). Time zones are checked with the runtime's own zone database
// (workerd's, for both the app that saves and the engine that fires), so save and firing agree.

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

/** A cron's sets as sorted arrays: two spellings of the same schedule have the same shape. */
export function cronShape(c: Cron) {
  const sorted = (x: ReadonlySet<number> | null) => (x ? [...x].sort((p, q) => p - q) : null);
  return {
    minute: c.minute,
    hours: sorted(c.hours),
    doms: sorted(c.doms),
    months: sorted(c.months),
    dows: sorted(c.dows),
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

// ---- Comparing schedules: in local calendar space, exact for every year (review of #197) ----

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Every local (month, day, weekday, hour) at which a cron could fire, as a callback: every valid
 * calendar date (29 February included) with every weekday, since each such combination happens in
 * some year. About 61,000 checks, no time zone and no clock.
 */
function eachLocalSlot(
  visit: (t: { month: number; day: number; weekday: number; hour: number }) => boolean,
) {
  for (let month = 1; month <= 12; month++)
    for (let day = 1; day <= (DAYS_IN_MONTH[month - 1] as number); day++)
      for (let weekday = 0; weekday < 7; weekday++)
        for (let hour = 0; hour < 24; hour++) if (!visit({ month, day, weekday, hour })) return;
}

/** Whether a cron never fires in any year (e.g. 31 February). */
export function cronNeverFires(c: Cron): boolean {
  let fires = false;
  eachLocalSlot((t) => {
    fires = cronMatches(c, { ...t, minute: c.minute });
    return !fires;
  });
  return !fires;
}

/**
 * Whether every local time `next` fires at, `prev` fires at too, in any year: the change fires at
 * no new time (in the same time zone; a time-zone change is a change of time, judged apart).
 */
export function cronWithin(next: Cron, prev: Cron): boolean {
  let within = true;
  eachLocalSlot((t) => {
    if (
      cronMatches(next, { ...t, minute: next.minute }) &&
      !cronMatches(prev, { ...t, minute: next.minute })
    )
      within = false;
    return within;
  });
  return within;
}

// ---- The next fire time: for the firing code (g2c), one time-zone conversion per candidate ----

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The local wall-clock fields of a UTC instant in a time zone. */
export function localTime(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** The zone's offset from UTC at an instant, in minutes. */
function offsetAt(ms: number, timeZone: string): number {
  const l = localTime(ms, timeZone);
  return Math.round(
    (Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) - Math.floor(ms / 60_000) * 60_000) /
      60_000,
  );
}

/** The years `nextFire` looks ahead: enough for 29 February after a skipped leap year. */
export const NEXT_FIRE_YEARS = 9;

/**
 * The next time a cron fires strictly after `after`, as UTC milliseconds, or null when it doesn't
 * within NEXT_FIRE_YEARS. Walks local calendar days (no clock per minute) and converts only the
 * matching candidates. Daylight saving, decided (review of #197): a local time that doesn't exist
 * (clocks go forward) fires at the first minute after the gap; one that happens twice (clocks go
 * back) fires once, the first time. The dedupe key of a firing is its local wall time, so the
 * repeated hour can't fire it again.
 */
export function nextFire(cron: Cron, timeZone: string, after: number): number | null {
  const start = localTime(after, timeZone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let d = 0; d <= NEXT_FIRE_YEARS * 366; d++) {
    const date = new Date(first + d * 86_400_000);
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (!cron.months.has(month)) continue;
    const dom = cron.doms ? cron.doms.has(day) : null;
    const dow = cron.dows ? cron.dows.has(weekday) : null;
    if (!(dom !== null && dow !== null ? dom || dow : (dom ?? dow ?? true))) continue;
    for (const hour of [...cron.hours].sort((a, b) => a - b)) {
      const wall = Date.UTC(date.getUTCFullYear(), month - 1, day, hour, cron.minute);
      const t = fromWall(wall, timeZone);
      if (t > after) return t;
    }
  }
  return null;
}

/** A local wall time to the UTC instant it fires at (the first of a repeated one; after a gap). */
function fromWall(wall: number, timeZone: string): number {
  // The offsets a day either side (a transition is never within a day of another): whichever
  // reads back as this wall time, the earliest.
  const fits = [
    offsetAt(wall - 24 * 3_600_000, timeZone),
    offsetAt(wall + 24 * 3_600_000, timeZone),
  ]
    .map((o) => wall - o * 60_000)
    .filter((t) => {
      const l = localTime(t, timeZone);
      return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) === wall;
    });
  if (fits.length) return Math.min(...fits);
  // It doesn't exist (clocks went forward): the first minute after the gap.
  // From before the gap, minute by minute: at most a few hours of a rare case.
  let t = wall - offsetAt(wall - 24 * 3_600_000, timeZone) * 60_000 - 180 * 60_000;
  for (let i = 0; i < 360; i++, t += 60_000) {
    const l = localTime(t, timeZone);
    if (Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) > wall) return t;
  }
  return t;
}
