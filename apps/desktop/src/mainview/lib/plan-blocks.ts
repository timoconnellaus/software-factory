// The plan's blocks in the Planning tab (spec 27, ADR 0471): which block a rendered element is,
// whether it is a person's edit, and the comments anchored to it. A block's lines are always the
// server's (`planBlocks`), never react-markdown's span: a list item's span takes in its nested
// list, and a quote the server doesn't know as a block matched nothing (review of #85, round 2).
import type { PlanningView } from "@software-factory/client/planning";
import { foldSpace, planBlocks } from "@software-factory/client/planning";

type Part = { text: string; lineStart: number; lineEnd: number };

/**
 * The block a rendered `p` or `li` is, by where it starts: the server's block starting on that line,
 * with its source lines. None for an element no block starts on, or a paragraph inside a list item
 * (only the item gets the controls).
 */
export function ownBlock(
  tag: "p" | "li",
  node: unknown,
  parts: Part[],
  sourceLines: string[],
): { lineStart: number; lineEnd: number; raw: string } | null {
  const pos = (node as { position?: { start: { line: number } } } | undefined)?.position;
  if (!pos) return null;
  const own = parts.find((b) => b.lineStart === pos.start.line - 1);
  if (!own) return null;
  const raw = sourceLines.slice(own.lineStart, own.lineEnd + 1).join("\n");
  if (tag === "p" && /^\s*([-*+]|\d+[.)])\s/.test(raw)) return null;
  return { lineStart: own.lineStart, lineEnd: own.lineEnd, raw };
}

/**
 * Whether a block is a person's edit: one of the blocks the edit wrote, exactly, as the server
 * compares them (ADR 0471, review of #85). Text the planner adds to it makes it the planner's.
 */
export const matchesEdit = (raw: string, after: string) =>
  planBlocks(after).some((b) => b.text === foldSpace(raw));

/**
 * The comments anchored to a block: the same text, and when several blocks read the same, the one
 * nearest the lines the comment was made on (review of #85).
 */
export function commentsOn(
  view: PlanningView,
  raw: string,
  lineStart: number,
  blocks: { text: string; lineStart: number }[],
) {
  const text = foldSpace(raw);
  const same = blocks.filter((b) => b.text === text);
  return view.messages.filter((m) => {
    if (!m.anchor || foldSpace(m.anchor.quote) !== text || same.length === 0) return false;
    const nearest = same.reduce((best, b) =>
      Math.abs(b.lineStart - (m.anchor?.lineStart ?? 0)) <
      Math.abs(best.lineStart - (m.anchor?.lineStart ?? 0))
        ? b
        : best,
    );
    return nearest.lineStart === lineStart;
  });
}
