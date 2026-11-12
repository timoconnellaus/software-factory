// Review of #85, round 2: the Planning tab's blocks are the server's. A list item with a nested
// list is the item's own lines (react-markdown's span takes in the nested list), so a comment on it
// is found again and nothing throws; every rendered block is a block `planBlocks` knows.
import { foldSpace, type PlanningView, planBlocks } from "@software-factory/client/planning";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { commentsOn, ownBlock } from "../src/mainview/lib/plan-blocks.ts";

const PLAN = `# Plan

- Issues labelled factory become work items
  - only from org members
  - edits update the item
- Closed on merge

A paragraph after the list.

1. First step
   with a second line
2. Second step`;

function render(messages: PlanningView["messages"] = []) {
  const parts = planBlocks(PLAN);
  const lines = PLAN.split("\n");
  const seen: { raw: string; comments: number }[] = [];
  const view = { messages } as PlanningView;
  const block =
    (tag: "p" | "li") =>
    ({ node, children }: { node?: unknown; children?: ReactNode }) => {
      const own = ownBlock(tag, node, parts, lines);
      if (own) {
        seen.push({
          raw: own.raw,
          comments: commentsOn(view, own.raw, own.lineStart, parts).length,
        });
      }
      return tag === "li" ? <li>{children}</li> : <p>{children}</p>;
    };
  renderToStaticMarkup(<Markdown components={{ p: block("p"), li: block("li") }}>{PLAN}</Markdown>);
  return seen;
}

describe("plan blocks in the Planning tab", () => {
  it("gives every rendered block exactly the server's lines, a nested list's item included", () => {
    const known = new Set(planBlocks(PLAN).map((b) => b.text));
    const seen = render();
    expect(seen.map((s) => s.raw)).toEqual([
      "- Issues labelled factory become work items",
      "  - only from org members",
      "  - edits update the item",
      "- Closed on merge",
      "A paragraph after the list.",
      "1. First step\n   with a second line",
      "2. Second step",
    ]);
    for (const s of seen) expect(known.has(foldSpace(s.raw))).toBe(true);
  });

  it("finds a comment on an item with a nested list, and a quote no block has doesn't throw", () => {
    const anchored = (quote: string, lineStart: number) =>
      ({
        id: `m${lineStart}`,
        anchor: { specId: "s", lineStart, lineEnd: lineStart, quote },
      }) as PlanningView["messages"][number];
    const seen = render([
      anchored("- Issues labelled factory become work items", 2),
      // An old anchor taken from react-markdown's span: no block reads like this any more.
      anchored(
        "- Issues labelled factory become work items\n  - only from org members\n  - edits update the item",
        2,
      ),
    ]);
    expect(seen[0]).toEqual({ raw: "- Issues labelled factory become work items", comments: 1 });
    expect(seen.slice(1).every((s) => s.comments === 0)).toBe(true);
  });
});
