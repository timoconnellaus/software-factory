// An item's kind has one source of truth (migration 0284, ADR 0514 as amended): `item_kind`, which
// is `autopilot` for an autopilot run whatever is stored. TypeScript refuses comparing the stored
// `kind` (its type is branded); this pins the raw SQL the compiler can't see, so a new read of the
// stored kind fails CI.
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

const RAW_READS = [
  // A work item's stored kind read through its usual alias, not `w.item_kind AS kind`.
  /\bw\.kind\b(?!\s+AS\b)/,
  // A comparison of a stored kind in SQL.
  /\bkind\s*(=|!=|<>|IN|NOT IN)\s*\(?\s*'(change|incident|attached)'/,
];

describe("an item's kind is read from item_kind only", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("no raw SQL reads or compares the stored kind", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(sources))
      text.split("\n").forEach((line, i) => {
        if (RAW_READS.some((re) => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    expect(found).toEqual([]);
  });
});
