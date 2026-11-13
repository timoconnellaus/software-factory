// An item's kind has one source of truth (migration 0284, ADR 0514 as amended): `item_kind`, which
// is `autopilot` for an autopilot run whatever is stored. TypeScript refuses comparing the stored
// `kind` (its type is branded); this pins the raw SQL the compiler can't see, so a new read of the
// stored kind fails CI. It reads every SQL literal (multi-line ones included) that names
// core_work_items, finds the table's aliases there, and flags `<alias>.kind`; where core_work_items
// is the literal's only table, a bare `kind` too (`kind = ?`, `SELECT kind`).
import { describe, expect, it } from "vitest";

// Vite needs each glob's options written inline.
const sources: Record<string, string> = {
  ...import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../../../packages/core/src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

const KEYWORDS = new Set([
  "where",
  "on",
  "join",
  "left",
  "inner",
  "set",
  "values",
  "group",
  "order",
  "limit",
  "as",
  "using",
  "indexed",
  "union",
  "and",
  "or",
  "select",
  "from",
  "returning",
  "default",
]);

/** The raw reads of a work item's stored kind in one source text. */
function rawKindReads(text: string): string[] {
  const found: string[] = [];
  // Template literals (multi-line) and quoted strings.
  const literals = [...text.matchAll(/`([^`]*)`|"([^"\n]*)"|'([^'\n]*)'/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  for (const sql of literals) {
    if (!/\bcore_work_items\b/.test(sql)) continue;
    // SQL only: a statement's verb, and none of the code a mismatched backtick pair would span.
    if (!/\b(SELECT|UPDATE|INSERT|DELETE)\b/.test(sql) || /===|=>/.test(sql)) continue;
    const aliases = new Set<string>(["core_work_items"]);
    for (const m of sql.matchAll(/\bcore_work_items\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi)) {
      const a = m[1];
      if (a && !KEYWORDS.has(a.toLowerCase())) aliases.add(a);
    }
    for (const a of aliases) {
      const re = new RegExp(`\\b${a}\\.kind\\b`, "g");
      for (const _ of sql.matchAll(re))
        found.push(`${a}.kind in: ${sql.slice(0, 120).replace(/\s+/g, " ")}`);
    }
    // Only work items in this statement: a bare `kind` is the stored one.
    const others = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)/gi)].filter(
      (m) => m[1] !== "core_work_items",
    );
    if (others.length === 0 && /(?<![._\w])kind\b/.test(sql.replace(/\bAS\s+kind\b/gi, "")))
      found.push(`bare kind in: ${sql.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  return found;
}

describe("an item's kind is read from item_kind only", () => {
  it("catches each way a raw read could be written", () => {
    for (const bad of [
      "`SELECT w.kind FROM core_work_items w WHERE w.id = ?`",
      "`SELECT t.kind FROM core_work_items AS t`",
      '"SELECT kind FROM core_work_items WHERE id = ?"',
      "`UPDATE core_work_items\n SET x = 1\n WHERE kind = ?`",
      "`SELECT a.id FROM core_jobs j JOIN core_work_items a ON a.id = j.work_item_id WHERE a.kind = 'incident'`",
    ])
      expect(rawKindReads(bad), bad).not.toEqual([]);
    for (const ok of [
      "`SELECT w.item_kind AS kind FROM core_work_items w`",
      "`SELECT pa.kind FROM core_pending_actions pa JOIN core_work_items w ON w.id = pa.work_item_id`",
      "`SELECT id FROM core_work_items WHERE item_kind != 'autopilot'`",
    ])
      expect(rawKindReads(ok), ok).toEqual([]);
  });

  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("no raw SQL reads or compares the stored kind", () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      rawKindReads(text).map((f) => `${file}: ${f}`),
    );
    expect(found).toEqual([]);
  });
});
