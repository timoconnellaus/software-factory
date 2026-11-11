// Times, durations and labels for the dashboard. Pure, so tests and SSR agree.

/** "12m ago", "3h ago", "2d ago"; "just now" under a minute. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  return `${duration(ms)} ago`;
}

/** 1m 40s, 23m, 2h 5m, 3d. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function between(from: string, to: string | null | undefined, now = Date.now()): number {
  return (to ? Date.parse(to) : now) - Date.parse(from);
}

/** 09:58, or "Nov 10, 09:58" when not today. */
export function clock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("en-AU", { month: "short", day: "numeric" })}, ${time}`;
}

export const STAGE_LABEL: Record<string, string> = {
  intake: "Intake",
  triage: "Triage",
  spec: "Spec",
  build: "Build",
  verify: "Verify",
  merge: "Merge",
  done: "Done",
};

export function capitalise(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : s;
}

/** The short item key, e.g. SF-12, from a project slug and number. */
export function itemKey(projectSlug: string | undefined, number: number): string {
  const prefix = (projectSlug ?? "wi")
    .split("-")
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return `${prefix || "WI"}-${number}`;
}
