// The plan's one segmentation (spec 27, ADR 0471, second review of #85): blocks, sections and
// fences; edits kept by section and count; and edits refused when the plan would read them
// differently from how the person wrote them.
import { describe, expect, it } from "vitest";
import { droppedEdits, type EditFootprint, editFootprint, planBlocks } from "../src/plan-blocks.ts";

const shape = (md: string) =>
  planBlocks(md).map((b) => [b.kind, b.text, b.lineStart, b.lineEnd, b.indent]);

describe("plan blocks", () => {
  it("makes a nested list item, and a paragraph or fence inside an item, blocks of their own", () => {
    const md = [
      "- a",
      "  - b",
      "    - c",
      "- d",
      "",
      "  a second paragraph of d",
      "",
      "  ```yaml",
      "  key:",
      "    nested: 1",
      "  ```",
      "- e",
    ].join("\n");
    expect(shape(md)).toEqual([
      ["item", "- a", 0, 0, 0],
      ["item", "- b", 1, 1, 2],
      ["item", "- c", 2, 2, 4],
      ["item", "- d", 3, 3, 0],
      ["paragraph", "a second paragraph of d", 5, 5, 2],
      ["fence", "```yaml\nkey:\n  nested: 1\n```", 7, 10, 2],
      ["item", "- e", 11, 11, 0],
    ]);
  });

  it("ends a paragraph where a numbered item starts, and keeps lazy continuation lines", () => {
    expect(shape("A paragraph\n2. a\nstill a")).toEqual([
      ["paragraph", "A paragraph", 0, 0, 0],
      ["item", "2. a still a", 1, 2, 0],
    ]);
  });

  it("reads fences as CommonMark does: a longer fence isn't closed by a shorter one, an unclosed one runs to the end, four spaces isn't a fence", () => {
    expect(shape("````\n```\nx\n```\n````\n- after")).toEqual([
      ["fence", "````\n```\nx\n```\n````", 0, 4, 0],
      ["item", "- after", 5, 5, 0],
    ]);
    expect(shape("```\nx\n- not an item")).toEqual([["fence", "```\nx\n- not an item", 0, 2, 0]]);
    expect(shape("Text\n\n    ```\n    not a fence")[1]?.[0]).toBe("paragraph");
  });

  it("doesn't fold space in a fence: indentation is meaning", () => {
    const [a] = planBlocks("```py\nif x:\n    y()\n```");
    const [b] = planBlocks("```py\nif x:\n  y()   \n```");
    expect(a?.text).not.toBe(b?.text);
    expect(planBlocks("```\nz   \n```")[0]?.text).toBe("```\nz\n```");
  });

  it("knows each block's section", () => {
    const md =
      "# Plan\n## Requirements\n- Never store PII\n## Out of scope\n- Billing\n### Later\n- SSO";
    expect(planBlocks(md).map((b) => [b.text, b.section])).toEqual([
      ["# Plan", ""],
      ["## Requirements", "Plan"],
      ["- Never store PII", "Plan › Requirements"],
      ["## Out of scope", "Plan"],
      ["- Billing", "Plan › Out of scope"],
      ["### Later", "Plan › Out of scope"],
      ["- SSO", "Plan › Out of scope › Later"],
    ]);
  });
});

describe("edits kept by section and count", () => {
  const PLAN =
    "# Plan\n## Requirements\n- Store only labels\n- TBD\n- TBD\n## Out of scope\n- Billing";
  const edit = (md: string, start: number, end: number, after: string) => {
    const r = editFootprint(md, start, end, after);
    if (!r.ok) throw new Error(r.reason);
    return { id: `${start}:${after}`, result: r.result, footprint: r.footprint };
  };

  it("drops an edit whose line moved to another section, or whose copy was deleted while another stays", () => {
    const e = edit(PLAN, 2, 2, "- Never store PII");
    expect(droppedEdits(e.result, [e])).toEqual([]);
    const moved = e.result
      .replace("- Never store PII\n", "")
      .replace("- Billing", "- Billing\n- Never store PII");
    expect(droppedEdits(moved, [e])).toEqual([e]);
    const twice = edit(PLAN, 3, 3, "- Label is factory");
    const both = edit(twice.result, 4, 4, "- Label is factory");
    // Two edits wrote the same line: the plan must keep both copies.
    const one = both.result.replace("- Label is factory\n- Label is factory", "- Label is factory");
    expect(droppedEdits(both.result, [twice, both])).toEqual([]);
    expect(droppedEdits(one, [twice, both])).toEqual([both]);
  });

  it("keeps a deletion of one of two identical lines (case b), and drops it when the copy comes back", () => {
    const del = edit(PLAN, 4, 4, "");
    expect(del.footprint.gone).toEqual([{ section: "Plan › Requirements", text: "- TBD", max: 1 }]);
    expect(droppedEdits(del.result, [del])).toEqual([]);
    expect(droppedEdits(PLAN, [del])).toEqual([del]);
  });

  it("refuses an edit the plan would read differently: an unclosed fence (c) or a lost list marker (d)", () => {
    const fence = editFootprint(PLAN, 3, 3, "```\ncode");
    expect(fence.ok).toBe(false);
    const marker = editFootprint(PLAN, 3, 3, "TBD now joins the item above");
    expect(marker.ok).toBe(false);
    const part = editFootprint("- a\n  continued\n- b", 1, 1, "  changed");
    expect(part).toMatchObject({ ok: false, reason: expect.stringContaining("whole blocks") });
  });

  it("drops a deletion when a later edit brings its text back (case a)", () => {
    const del = edit("- a\n- b", 0, 0, "");
    const back = edit(del.result, 0, 0, "- a");
    expect(droppedEdits(back.result, [del])).toEqual([del]);
    expect(droppedEdits(back.result, [back])).toEqual([]);
  });

  it("keeps fence content exactly", () => {
    const md = "## Config\n```yaml\nkey:\n  nested: 1\n```";
    const e = edit(md, 1, 4, "```yaml\nkey:\n  nested: 2\n```");
    const f: EditFootprint = e.footprint;
    expect(droppedEdits(e.result, [{ footprint: f }])).toEqual([]);
    expect(
      droppedEdits(e.result.replace("  nested: 2", "nested: 2"), [{ footprint: f }]),
    ).toHaveLength(1);
  });
});
