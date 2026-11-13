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
/** The org config's top-level keys this diff shows (a test pins them to the schema's). */
export const ORG_CONFIG_KEYS = ["version", "workflows", "builtIns", "archived", "agents"] as const;

/** Workflows keyed by id: every field of each, those added or removed in full. */
function workflowsDiff(was: Rec[], now: Rec[], prefix: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const id of [...new Set([...was, ...now].map((w) => String(w.id)))]) {
    const b = was.find((w) => String(w.id) === id) ?? null;
    const a = now.find((w) => String(w.id) === id) ?? null;
    const name = text((a ?? b)?.name);
    const label = `${prefix}${name}`;
    if (!b || !a) rows.push({ label, was: b ? "present" : "none", now: a ? "added" : "removed" });
    // Added or removed: its fields too, so nothing it brings or takes is hidden.
    for (const r of workflowDiff(b, a)) rows.push({ ...r, label: `${label}: ${r.label}` });
  }
  return rows;
}

/**
 * Every difference between two whole org configs (a rollback): each top-level key of the schema
 * (ORG_CONFIG_KEYS), workflows and the built-in copies and archived versions field by field,
 * agents by name with every field; anything else differing is shown whole (review of #159).
 */
export function orgConfigDiff(before: unknown, after: unknown): DiffRow[] {
  const b = rec(before) ?? {};
  const a = rec(after) ?? {};
  const list = (r: Rec, k: string) => (Array.isArray(r[k]) ? (r[k] as Rec[]) : []);
  const rows: DiffRow[] = [];
  if (differ(b.version, a.version))
    rows.push({ label: "Config schema version", was: text(b.version), now: text(a.version) });
  rows.push(...workflowsDiff(list(b, "workflows"), list(a, "workflows"), "Workflow "));
  const builtIns = (r: Rec) =>
    Object.entries(rec(r.builtIns) ?? {}).map(([kind, w]) => ({
      ...(rec(w) ?? {}),
      id: `builtIn:${kind}`,
      name: `${kind} (the org's copy)`,
    }));
  rows.push(...workflowsDiff(builtIns(b), builtIns(a), "Built-in "));
  rows.push(...workflowsDiff(list(b, "archived"), list(a, "archived"), "Archived "));
  const ab = list(b, "agents");
  const aa = list(a, "agents");
  const key = (x: Rec) => String(x.name).toLowerCase();
  for (const k of [...new Set([...ab, ...aa].map(key))]) {
    const was = ab.find((x) => key(x) === k) ?? null;
    const now = aa.find((x) => key(x) === k) ?? null;
    const label = `Agent ${text((now ?? was)?.name)}`;
    if (!was || !now)
      rows.push({ label, was: was ? "present" : "none", now: now ? "added" : "removed" });
    for (const r of agentDiff(was ?? {}, now ?? {}))
      rows.push({ ...r, label: `${label}: ${r.label}` });
  }
  // A key the schema gains later and this diff doesn't know yet: shown whole, never hidden.
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)]))
    if (!(ORG_CONFIG_KEYS as readonly string[]).includes(k) && differ(b[k], a[k]))
      rows.push({ label: k, was: text(b[k]), now: text(a[k]) });
  return rows;
}

/**
 * The changed region of two texts, with what is invisible made visible: the common start and end
 * shortened to context, the differing middle marked. Whitespace at the edges, tabs, and format
 * characters (zero-width, bidi) are shown as markers, so no change is invisible.
 */
export function changedRegion(was: string, now: string, context = 40) {
  // By code point, never splitting a surrogate pair.
  const w = Array.from(was);
  const n = Array.from(now);
  let start = 0;
  while (start < w.length && start < n.length && w[start] === n[start]) start++;
  let end = 0;
  while (
    end < w.length - start &&
    end < n.length - start &&
    w[w.length - 1 - end] === n[n.length - 1 - end]
  )
    end++;
  const point = (c: string) =>
    `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
  // Invisible or look-alike-making characters, everywhere: format (zero-width, bidi), control
  // (but a line break), carriage return, spaces other than ASCII's, combining marks and variation
  // selectors. Tabs as ⇥.
  const shown = (chars: string[]) =>
    chars
      .map((c) =>
        c === "\t"
          ? "⇥"
          : c === "\r"
            ? "⟨CR⟩"
            : c !== "\n" && /[\p{Cf}\p{Cc}\p{M}]|[^\S\n\t ]|\p{Zs}/u.test(c) && c !== " "
              ? point(c)
              : c,
      )
      .join("");
  // In the changed part, ASCII spaces too, and any other non-ASCII character with its code point
  // beside it: a look-alike (a Cyrillic "а" for a Latin "a") reads differently.
  const marked = (chars: string[]) =>
    chars
      .map((c) => {
        const v = shown([c]);
        if (c === " ") return "·";
        return v === c && (c.codePointAt(0) ?? 0) > 0x7f ? `${c}${point(c)}` : v;
      })
      .join("");
  let wasPart = marked(w.slice(start, w.length - end));
  let nowPart = marked(n.slice(start, n.length - end));
  // Look-alikes (a Cyrillic "а" for a Latin "a"): the same on screen, so show code points.
  if (wasPart === nowPart && w.join("") !== n.join("")) {
    wasPart = w
      .slice(start, w.length - end)
      .map(point)
      .join("");
    nowPart = n
      .slice(start, n.length - end)
      .map(point)
      .join("");
  }
  return {
    before: (start > context ? "…" : "") + shown(w.slice(Math.max(0, start - context), start)),
    was: wasPart,
    now: nowPart,
    after: shown(w.slice(w.length - end, w.length - end + context)) + (end > context ? "…" : ""),
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
