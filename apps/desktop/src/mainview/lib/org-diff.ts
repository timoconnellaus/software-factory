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
const differ = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

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
