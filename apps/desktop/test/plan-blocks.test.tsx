// Second review of #85: the Planning tab renders the plan block by block from `planBlocks`, the
// server's segmentation, so every block on screen is one the server knows, whatever the Markdown:
// nested lists, a paragraph or fence inside an item, a paragraph straight before a numbered item.
// A comment no block reads like is an orphan and never throws.
import { type PlanningView, planBlocks } from "@software-factory/client/planning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanBody } from "../src/mainview/components/plan-body.tsx";
import { commentsOn, orphanedComments, quoteText } from "../src/mainview/lib/plan-blocks.ts";

const PLAN = [
  "## Scope",
  "- a",
  "  - b",
  "    - c",
  "- d",
  "",
  "  a paragraph inside d",
  "",
  "  ```yaml",
  "  key:",
  "    nested: 1",
  "  ```",
  "",
  "A paragraph",
  "2. a numbered item",
].join("\n");

const anchored = (id: string, quote: string, lineStart: number) =>
  ({
    id,
    author: "person",
    authorId: "u",
    authorName: "You",
    text: "?",
    questionId: null,
    replyTo: null,
    kind: "chat",
    deliveredAt: null,
    createdAt: "2026-11-12T00:00:00.000Z",
    anchor: { specId: "s", lineStart, lineEnd: lineStart, quote },
  }) as PlanningView["messages"][number];

function view(messages: PlanningView["messages"]): PlanningView {
  return { messages, edits: [], questions: [] } as unknown as PlanningView;
}

function render(v: PlanningView) {
  return renderToStaticMarkup(
    <PlanBody
      view={v}
      bodyMd={PLAN}
      specId="s"
      previous={null}
      components={{}}
      workItemId="wi"
      me="u"
      onComment={() => {}}
    />,
  );
}

describe("the plan, block by block", () => {
  it("renders exactly the server's blocks, each with its own controls", () => {
    const html = render(view([]));
    const kinds = [...html.matchAll(/data-block="(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(planBlocks(PLAN).map((b) => b.kind));
    expect(kinds).toEqual([
      "heading",
      "item",
      "item",
      "item",
      "item",
      "paragraph",
      "fence",
      "paragraph",
      "item",
    ]);
    expect(html.match(/data-testid="plan-block-edit"/g)).toHaveLength(9);
    // A fence's indentation survives (rendered from its own dedented lines).
    expect(html).toContain("key:\n  nested: 1");
  });

  it("counts comments on a nested item and a fence, and lists a stale quote as an orphan without throwing", () => {
    const stale = anchored("old", "- a\n  - b\n    - c", 1);
    const v = view([
      anchored("nested", "  - b", 2),
      anchored("fence", "  ```yaml\n  key:\n    nested: 1\n  ```", 8),
      stale,
    ]);
    const html = render(v);
    expect(html.match(/data-testid="plan-block-comments"/g)).toHaveLength(2);
    const parts = planBlocks(PLAN);
    const fence = parts.find((b) => b.kind === "fence");
    if (!fence) throw new Error("no fence");
    expect(commentsOn(v, fence, parts).map((m) => m.id)).toEqual(["fence"]);
    expect(orphanedComments(v, PLAN).map((m) => m.id)).toEqual(["old"]);
    expect(quoteText(stale.anchor?.quote ?? "")).not.toBe(parts[1]?.text);
  });
});
