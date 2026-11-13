// What an org change changes, field by field (review of #159): every field of every stage (name,
// type, phase, agent, "only when", settings), stages added or removed, their order, the workflow's
// own name and description; for an agent, every field it has (role, tier, instructions, requires…).
// Pure: the pending cards and the "changed while you were editing" panel show these rows, and a
// change the engine says changes something but these rows don't show can't be approved.

export interface DiffRow {
  label: string;
  was: string;
  now: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
/** A value in full: never cut, so two different values never read the same (review of #159). */
const text = (v: unknown): string => {
  if (v === undefined || v === null) return "none";
  if (typeof v === "string") return v || "empty";
  return JSON.stringify(v, null, 1);
};
/** JSON with object keys sorted: a change of key order alone is not a difference. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Rec)
      .sort()
      .filter((k) => (v as Rec)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Rec)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
const differ = (a: unknown, b: unknown) => canonical(a) !== canonical(b);

const STAGE_FIELDS = ["name", "type", "typeVersion", "phase", "agent", "when", "settings"] as const;

/** Every difference between two versions of a workflow (either may be missing: added or removed). */
export function workflowDiff(before: unknown, after: unknown): DiffRow[] {
  const b = rec(before);
  const a = rec(after);
  const rows: DiffRow[] = [];
  for (const f of ["name", "description", "template"])
    if (differ(b?.[f], a?.[f]))
      rows.push({ label: `Workflow ${f}`, was: text(b?.[f]), now: text(a?.[f]) });
  const stages = (w: Rec | null) => (Array.isArray(w?.stages) ? (w.stages as Rec[]) : []);
  const was = stages(b);
  const now = stages(a);
  const ids = (l: Rec[]) => l.map((s) => String(s.id));
  if (differ(ids(was), ids(now)))
    rows.push({
      label: "Stages",
      was: was.map((s) => text(s.name)).join(" → ") || "none",
      now: now.map((s) => text(s.name)).join(" → ") || "none",
    });
  for (const s of now) {
    const old = was.find((x) => x.id === s.id);
    for (const f of STAGE_FIELDS)
      if (differ(old?.[f], s[f]))
        rows.push({
          label: `${text(s.name)}: ${f}${old ? "" : " (new stage)"}`,
          was: old ? text(old[f]) : "none",
          now: text(s[f]),
        });
  }
  for (const s of was)
    if (!now.some((x) => x.id === s.id))
      rows.push({ label: `${text(s.name)} (removed)`, was: text(s.type), now: "removed" });
  return rows;
}

/** Every field of an agent that differs (whatever fields it has). */
/**
 * Every difference between two whole org configs (a rollback): each workflow by id, field by
 * field, workflows added or removed, and each agent by name (review of #159, round 4).
 */
export function orgConfigDiff(before: unknown, after: unknown): DiffRow[] {
  const b = rec(before);
  const a = rec(after);
  const list = (r: Rec | null, k: string) => (Array.isArray(r?.[k]) ? (r[k] as Rec[]) : []);
  const rows: DiffRow[] = [];
  const wb = list(b, "workflows");
  const wa = list(a, "workflows");
  for (const id of [...new Set([...wb, ...wa].map((w) => String(w.id)))]) {
    const was = wb.find((w) => String(w.id) === id) ?? null;
    const now = wa.find((w) => String(w.id) === id) ?? null;
    const name = text((now ?? was)?.name);
    if (!was || !now) {
      rows.push({
        label: `Workflow ${name}`,
        was: was ? "present" : "none",
        now: now ? "added back" : "removed",
      });
      continue;
    }
    for (const r of workflowDiff(was, now)) rows.push({ ...r, label: `${name}: ${r.label}` });
  }
  const ab = list(b, "agents");
  const aa = list(a, "agents");
  const key = (x: Rec) => String(x.name).toLowerCase();
  for (const k of [...new Set([...ab, ...aa].map(key))]) {
    const was = ab.find((x) => key(x) === k) ?? null;
    const now = aa.find((x) => key(x) === k) ?? null;
    const name = text((now ?? was)?.name);
    if (!was || !now) {
      rows.push({
        label: `Agent ${name}`,
        was: was ? "present" : "none",
        now: now ? "added back" : "removed",
      });
      continue;
    }
    for (const r of agentDiff(was, now)) rows.push({ ...r, label: `Agent ${name}: ${r.label}` });
  }
  return rows;
}

/**
 * The changed region of two texts, with what is invisible made visible: the common start and end
 * shortened to context, the differing middle marked. Whitespace at the edges, tabs, and format
 * characters (zero-width, bidi) are shown as markers, so no change is invisible.
 */
export function changedRegion(was: string, now: string, context = 40) {
  let start = 0;
  while (start < was.length && start < now.length && was[start] === now[start]) start++;
  let end = 0;
  while (
    end < was.length - start &&
    end < now.length - start &&
    was[was.length - 1 - end] === now[now.length - 1 - end]
  )
    end++;
  const shown = (s: string) =>
    s
      .replace(
        /\p{Cf}/gu,
        (c) => `⟨U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}⟩`,
      )
      .replace(/\t/g, "⇥");
  // In the changed part, spaces too: a space added or removed is a change you can see.
  const marked = (s: string) => shown(s).replace(/ /g, "·");
  const pre = was.slice(Math.max(0, start - context), start);
  return {
    before: (start > context ? "…" : "") + shown(pre),
    was: marked(was.slice(start, was.length - end)),
    now: marked(now.slice(start, now.length - end)),
    after:
      shown(was.slice(was.length - end, was.length - end + context)) + (end > context ? "…" : ""),
  };
}

/** Rows that render the same text on both sides: the difference isn't shown, so nothing to approve. */
export const unreadable = (rows: DiffRow[]) => rows.some((r) => r.was === r.now);

export function agentDiff(before: unknown, after: unknown): DiffRow[] {
  const b = rec(before) ?? {};
  const a = rec(after) ?? {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .sort()
    .filter((k) => differ(b[k], a[k]))
    .map((k) => ({ label: k, was: text(b[k]), now: text(a[k]) }));
}
