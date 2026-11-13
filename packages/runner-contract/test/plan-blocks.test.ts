// The plan's one segmentation (spec 27, ADR 0471, second review of #85): blocks, sections and
// fences; edits kept by section and count; and edits refused when the plan would read them
// differently from how the person wrote them.
import { describe, expect, it } from "vitest";
import {
  changedSpan,
  droppedEdits,
  type EditFootprint,
  editAnswer,
  editFootprint,
  mentions,
  planBlocks,
  rekeyFootprint,
  structureMoves,
  whyNotKept,
} from "../src/plan-blocks.ts";

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
    expect(del.footprint.gone).toEqual([
      { section: "Plan › Requirements", parent: "", text: "- TBD", max: 1 },
    ]);
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

describe("third review of #85", () => {
  const edit = (md: string, start: number, end: number, after: string) => {
    const r = editFootprint(md, start, end, after);
    if (!r.ok) throw new Error(r.reason);
    return { id: `${start}:${after}`, result: r.result, footprint: r.footprint };
  };

  it("reads a CRLF plan as an LF one (4)", () => {
    const lf = "# Plan\n## Scope\n```\nx\n```\n- a";
    expect(planBlocks(lf.replace(/\n/g, "\r\n"))).toEqual(planBlocks(lf));
  });

  it("makes a setext heading a section, and tells repeated headings apart (5, 7)", () => {
    const md = "Plan\n====\n\nNotes\n-----\n- a\n\n## Notes\n- b";
    expect(planBlocks(md).map((b) => [b.kind, b.section])).toEqual([
      ["heading", ""],
      ["heading", "Plan"],
      ["item", "Plan › Notes"],
      ["heading", "Plan"],
      ["item", "Plan › Notes (2)"],
    ]);
  });

  it("knows a nested block's parent item, and numbers an ordered list in order (5, 7)", () => {
    const md = "1. one\n1. two\n   - inner\n1. three\n\n   para in three";
    expect(planBlocks(md).map((b) => [b.text, b.parent, b.ordinal])).toEqual([
      ["1. one", "", 1],
      ["1. two", "", 2],
      ["- inner", "1. two", null],
      ["1. three", "", 3],
      ["para in three", "1. three", null],
    ]);
  });

  it("drops an edit whose line moved to another duplicate section or under another parent (5)", () => {
    const md = "## Notes\n- a\n\n## Notes\n- b\n- x\n  - kept";
    const e = edit(md, 1, 1, "- mine");
    expect(droppedEdits(e.result, [e])).toEqual([]);
    const otherNotes = e.result.replace("- mine\n", "").replace("- b", "- b\n- mine");
    expect(droppedEdits(otherNotes, [e])).toEqual([e]);
    const n = edit(md, 6, 6, "  - nested mine");
    const demoted = n.result.replace("- x\n  - nested mine", "- x\n- b2\n  - nested mine");
    expect(droppedEdits(demoted, [n])).toEqual([n]);
  });

  it("takes as the person's only the blocks that changed (6)", () => {
    const e = edit("## Scope\n- a\n- b", 1, 2, "- a\n- b\n- c");
    expect(e.footprint).toEqual({
      blocks: [{ section: "Scope", parent: "", text: "- c" }],
      gone: [],
    });
  });

  it("keeps a replaced line out as a whole block; a longer line mentioning it is listed, not refused (4th review, 3)", () => {
    const e = edit("## Stack\n- Use MySQL\n- Auth: X", 1, 1, "- Use Postgres");
    expect(e.footprint.gone).toEqual([
      { section: "Stack", parent: "", text: "- Use MySQL", max: 0 },
    ]);
    const mention = `${e.result}\n- Migration from Use MySQL is out of scope`;
    expect(droppedEdits(mention, [e])).toEqual([]);
    expect(mentions(mention, e.footprint)).toEqual(["- Migration from Use MySQL is out of scope"]);
    const back = `${e.result}\n- Use MySQL`;
    expect(droppedEdits(back, [e])).toEqual([e]);
    expect(whyNotKept(back, e.footprint)).toContain("is back in Stack");
    // Case, spacing and the list marker don't bring it back either (review of #85).
    for (const again of ["- use mysql", "* Use  MySQL", "1. USE MYSQL"]) {
      expect(droppedEdits(`${e.result}\n${again}`, [e])).toEqual([e]);
    }
    const tbd = edit("## Stack\n- TBD", 1, 1, "- Postgres");
    expect(droppedEdits(`${tbd.result}\n- Auth: TBD`, [tbd])).toEqual([]);
  });

  it("carries edits along when a person's edit moves structure: a reworded parent, a heading inserted above, sections reordered (4th review, 2)", () => {
    const md = "## Notes\n- parent\n  - child\n\n## Other\n- x";
    const child = edit(md, 2, 2, "  - Ana's child");
    // Someone rewords the parent: the child's edit follows.
    const reworded = child.result.replace("- parent", "- parent, reworded");
    const moves1 = structureMoves(child.result, reworded, 1, 1, 1);
    const f1 = rekeyFootprint(child.footprint, moves1);
    expect(droppedEdits(reworded, [{ footprint: f1 }])).toEqual([]);
    expect(droppedEdits(reworded, [child])).toEqual([child]);
    // A new "## Notes" inserted above: the old one becomes "Notes (2)", and the edit follows.
    const inserted = `## Notes\n- new\n\n${child.result}`;
    const f2 = rekeyFootprint(child.footprint, structureMoves(child.result, inserted, 0, -1, 3));
    expect(f2.blocks[0]?.section).toBe("Notes (2)");
    expect(droppedEdits(inserted, [{ footprint: f2 }])).toEqual([]);
    // Sections reordered in one edit: blocks inside the edited lines keep their keys by text.
    const x = edit(md, 5, 5, "- x mine");
    const reordered = "## Other\n- x mine\n\n## Notes\n- parent\n  - child";
    expect(droppedEdits(reordered, [x])).toEqual([]);
  });

  it("says exactly what differs when the planner breaks an edit", () => {
    const e = edit("## Scope\n- a\n## Out\n- b", 1, 1, "- mine");
    expect(whyNotKept("## Scope\n## Out\n- b\n- mine", e.footprint)).toContain(
      "moved: it belongs in Scope",
    );
    expect(whyNotKept("## Scope\n- mine, reworded\n## Out\n- b", e.footprint)).toContain(
      'the plan has "mine, reworded" there instead',
    );
  });

  it("records an answer from an edit only when the change IS an option, or the whole span for a question with none (4th review, 1)", () => {
    const span = (after: string) => changedSpan("- Database: TBD [Q3]", after, "[Q3]");
    const options = ["Postgres", "SQLite"];
    for (const after of [
      "- Database: anything but Postgres [Q3]",
      "- Database: Postgres is out [Q3]",
      "- Database: kein Postgres [Q3]",
      "- Database: maybe Postgres? [Q3]",
      "- Database: SQLite now, Postgres later [Q3]",
      "- Database: Postgres or SQLite [Q3]",
      "- Database: Postgres with replicas [Q3]",
    ]) {
      expect(editAnswer(span(after), options)).toBeNull();
    }
    expect(editAnswer(span("- Database: postgres. [Q3]"), options)).toBe("Postgres");
    expect(editAnswer(span("- Database: SQLite on disk [Q3]"), [])).toBe("SQLite on disk");
  });

  it("needs an exact match when options differ only by punctuation or case (review of #85)", () => {
    const span = (after: string) => changedSpan("- Language: TBD [Q4]", after, "[Q4]");
    const options = ["C", "C#", "C++"];
    expect(editAnswer(span("- Language: C# [Q4]"), options)).toBe("C#");
    expect(editAnswer(span("- Language: C++ [Q4]"), options)).toBe("C++");
    expect(editAnswer(span("- Language: C [Q4]"), options)).toBe("C");
    expect(editAnswer(span("- Language: c# [Q4]"), options)).toBeNull();
    expect(editAnswer(span("- Language: C. [Q4]"), options)).toBeNull();
  });

  it("accepts an edit of a fence inside a 10. item (7)", () => {
    const md = "10. ten\n\n    ```\n    x\n    ```";
    expect(editFootprint(md, 2, 4, "    ```\n    y\n    ```").ok).toBe(true);
  });
});
