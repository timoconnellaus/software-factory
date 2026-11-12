// The plan's blocks in the Planning tab (spec 27, ADR 0471, second review of #85). The plan is
// rendered block by block from `planBlocks`, the server's own segmentation, so a block on screen is
// a block the server knows; these say which edit wrote a block and which comments are on it.
import {
  editWrote,
  type PlanBlock,
  type PlanningView,
  planBlocks,
} from "@software-factory/client/planning";

/** A quote's text as the server compares blocks (space folded, a fence kept exactly). */
export const quoteText = (quote: string) =>
  planBlocks(quote)
    .map((b) => b.text)
    .join("\n\n");

/** The standing edit that wrote this block (same section, same text), if any. */
export function editOf(view: Pick<PlanningView, "edits">, block: PlanBlock) {
  return view.edits.find((e) => editWrote({ blocks: e.blocks, gone: [] }, block));
}

/**
 * The comments anchored to a block: the same text, and when several blocks read the same, the one
 * nearest the lines the comment was made on. A comment no block reads like is an orphan, listed
 * under the plan; it never matches here, and never throws.
 */
export function commentsOn(
  view: Pick<PlanningView, "messages">,
  block: Pick<PlanBlock, "text" | "lineStart">,
  blocks: Pick<PlanBlock, "text" | "lineStart">[],
) {
  const same = blocks.filter((b) => b.text === block.text);
  if (same.length === 0) return [];
  return view.messages.filter((m) => {
    if (!m.anchor || quoteText(m.anchor.quote) !== block.text) return false;
    const at = m.anchor.lineStart;
    let nearest = same[0];
    for (const b of same) {
      if (nearest && Math.abs(b.lineStart - at) < Math.abs(nearest.lineStart - at)) nearest = b;
    }
    return nearest?.lineStart === block.lineStart;
  });
}

/** Comments whose quote no block of the plan reads like any more. */
export function orphanedComments(view: Pick<PlanningView, "messages">, bodyMd: string) {
  const present = new Set(planBlocks(bodyMd).map((b) => b.text));
  return view.messages.filter((m) => m.anchor && !present.has(quoteText(m.anchor.quote)));
}
