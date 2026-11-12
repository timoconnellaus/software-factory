// The plan's blocks (spec 27, ADR 0471, second review of #85): ONE segmentation of a plan's
// Markdown, used by the server (which edits are kept, comment anchors) and by the app (which renders
// the plan block by block from it, so a block on screen is by construction a block on the server).
//
// A block is a heading, a list item (with its lazy continuation lines), a paragraph or a fenced code
// block. A nested list item, and a paragraph or fence inside a list item, are blocks of their own,
// indented. Each block knows its section: the path of headings above it. A person's edit is kept by
// section and by count (a multiset), so moving a line to another section or deleting the person's
// copy of a duplicated line doesn't count as keeping it.

/** One block of a plan's Markdown. */
export interface PlanBlock {
  kind: "heading" | "item" | "paragraph" | "fence";
  /**
   * What "word for word" compares: runs of space folded, except in a fence, where indentation is
   * meaning (YAML, Python) and only trailing space is ignored.
   */
  text: string;
  /** The headings above it, outermost first, joined with " › " ("" before the first heading). */
  section: string;
  /** The first line's indent, in columns: how deep in a list it sits. */
  indent: number;
  /** 0-based source lines, inclusive. */
  lineStart: number;
  lineEnd: number;
}

/** Folds runs of space: the comparison is word for word, not byte for byte. */
export const foldSpace = (text: string) => text.replace(/\s+/g, " ").trim();

const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/;
const FENCE_OPEN = /^( *)(`{3,}|~{3,})(.*)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const expandTabs = (line: string) => line.replace(/\t/g, "    ");

/** Removes up to `n` columns of leading space from each line. */
export function dedent(lines: string[], n: number): string[] {
  return lines.map((l) => l.replace(new RegExp(`^ {0,${n}}`), ""));
}

/** A plan's blocks, in order. */
export function planBlocks(md: string): PlanBlock[] {
  const lines = md.split("\n").map(expandTabs);
  const out: PlanBlock[] = [];
  const headings: { level: number; text: string }[] = [];
  const section = () => headings.map((h) => h.text).join(" › ");
  let current: { kind: PlanBlock["kind"]; lines: string[]; start: number; indent: number } | null =
    null;
  // The content column of the list item we're in, for fences inside it; null outside a list.
  let itemCol: number | null = null;
  let afterBlank = true;
  let fence: { char: string; len: number; indent: number } | null = null;

  const close = (end: number) => {
    if (!current) return;
    const body =
      current.kind === "fence"
        ? dedent(current.lines, current.indent)
            .map((l) => l.trimEnd())
            .join("\n")
        : foldSpace(current.lines.join("\n"));
    out.push({
      kind: current.kind,
      text: body,
      section: current.kind === "heading" ? headingSection : section(),
      indent: current.indent,
      lineStart: current.start,
      lineEnd: end,
    });
    current = null;
  };
  let headingSection = "";

  lines.forEach((line, i) => {
    if (fence) {
      current?.lines.push(line);
      const t = line.trim();
      const closes =
        indentOf(line) < fence.indent + 4 &&
        t.length >= fence.len &&
        t === fence.char.repeat(t.length);
      if (closes) {
        fence = null;
        close(i);
      }
      return;
    }
    const indent = indentOf(line);
    if (line.trim() === "") {
      close(i - 1);
      afterBlank = true;
      return;
    }
    const open = FENCE_OPEN.exec(line);
    const fenceHere =
      open &&
      !(open[2]?.startsWith("`") && open[3]?.includes("`")) &&
      (indent <= 3 || (itemCol !== null && indent >= itemCol && indent - itemCol <= 3));
    if (open && fenceHere) {
      close(i - 1);
      const marker = open[2] ?? "```";
      fence = { char: marker[0] ?? "`", len: marker.length, indent };
      current = { kind: "fence", lines: [line], start: i, indent };
      afterBlank = false;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading && indent <= 3) {
      close(i - 1);
      const level = heading[1]?.length ?? 1;
      while (headings.length && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
      headingSection = section();
      current = { kind: "heading", lines: [line], start: i, indent };
      close(i);
      headings.push({ level, text: foldSpace(heading[2] ?? "").replace(/\s#+$/, "") });
      itemCol = null;
      afterBlank = false;
      return;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      close(i - 1);
      itemCol = (item[1]?.length ?? 0) + (item[2]?.length ?? 1) + Math.max(1, item[3]?.length ?? 1);
      current = { kind: "item", lines: [line], start: i, indent };
      afterBlank = false;
      return;
    }
    if (current) {
      // A lazy continuation of the paragraph or item above.
      current.lines.push(line);
      afterBlank = false;
      return;
    }
    // A new paragraph. After a blank line, one indented less than the item's content leaves the list.
    if (afterBlank && itemCol !== null && indent < Math.min(itemCol, 2)) itemCol = null;
    current = { kind: "paragraph", lines: [line], start: i, indent };
    afterBlank = false;
  });
  close(lines.length - 1);
  return out;
}

/** A block's identity for keeping edits: its section and its text. */
export interface PlanKey {
  section: string;
  text: string;
}

/** What a person's edit asks the planner to keep (stored with the edit). */
export interface EditFootprint {
  /** Blocks the edit wrote: each must stay in the plan, in its section, as many times as written. */
  blocks: PlanKey[];
  /** Blocks the edit deleted: each may appear in its section at most `max` times. */
  gone: (PlanKey & { max: number })[];
}

const keyOf = (k: PlanKey) => `${k.section}␟${k.text}`;

/** How many times each block (section and text) appears in a plan. */
export function planCounts(md: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of planBlocks(md)) counts.set(keyOf(b), (counts.get(keyOf(b)) ?? 0) + 1);
  return counts;
}

/**
 * The edits a plan doesn't keep. Edits are taken in order and each takes the copies it needs, so two
 * edits that both wrote "- TBD" in a section need two of them. A deletion is kept while its blocks
 * appear no more often than it left them.
 */
export function droppedEdits<E extends { footprint: EditFootprint }>(md: string, edits: E[]): E[] {
  const counts = planCounts(md);
  const used = new Map<string, number>();
  return edits.filter((e) => {
    const need = new Map<string, number>();
    for (const b of e.footprint.blocks) need.set(keyOf(b), (need.get(keyOf(b)) ?? 0) + 1);
    const writes = [...need].every(([k, n]) => (counts.get(k) ?? 0) - (used.get(k) ?? 0) >= n);
    const deletes = e.footprint.gone.every((g) => (counts.get(keyOf(g)) ?? 0) <= g.max);
    if (!writes || !deletes) return true;
    for (const [k, n] of need) used.set(k, (used.get(k) ?? 0) + n);
    return false;
  });
}

/** Whether a rendered block is one an edit wrote (same section, same text). */
export function editWrote(footprint: EditFootprint, block: PlanKey): boolean {
  return footprint.blocks.some((b) => keyOf(b) === keyOf(block));
}

/**
 * What an edit of lines `lineStart..lineEnd` of `body` to `after` keeps, or why it can't be kept.
 * The lines must be whole blocks of the plan, and `after` must be the same blocks in the resulting
 * plan as on its own: an unclosed fence that swallows what follows, or a line that loses its list
 * marker and joins the item above, isn't the edit the person saw.
 */
export function editFootprint(
  body: string,
  lineStart: number,
  lineEnd: number,
  after: string,
): { ok: true; result: string; footprint: EditFootprint } | { ok: false; reason: string } {
  const lines = body.split("\n");
  const before = planBlocks(body);
  const inRange = (b: PlanBlock, s: number, e: number) => b.lineEnd >= s && b.lineStart <= e;
  const touched = before.filter((b) => inRange(b, lineStart, lineEnd));
  if (touched.some((b) => b.lineStart < lineStart || b.lineEnd > lineEnd)) {
    return { ok: false, reason: "edit whole blocks of the plan: a line, a list item or a fence" };
  }
  const afterLines = after.trim() === "" ? [] : after.split("\n");
  const result = [...lines.slice(0, lineStart), ...afterLines, ...lines.slice(lineEnd + 1)].join(
    "\n",
  );
  const blocks = planBlocks(result);
  const end = lineStart + afterLines.length - 1;
  const mine = afterLines.length ? blocks.filter((b) => inRange(b, lineStart, end)) : [];
  const alone = planBlocks(after);
  const same =
    mine.length === alone.length &&
    mine.every(
      (b, i) =>
        b.lineStart >= lineStart &&
        b.lineEnd <= end &&
        b.kind === alone[i]?.kind &&
        b.text === alone[i]?.text,
    );
  if (!same) {
    return {
      ok: false,
      reason:
        "the plan would read your edit differently from how you wrote it (an unclosed code fence, or a line that joins the item above): close the fence, or keep the list marker",
    };
  }
  const counts = planCounts(result);
  const gone = touched
    .filter((b) => !mine.some((m) => m.text === b.text && m.section === b.section))
    .map((b) => ({ section: b.section, text: b.text, max: counts.get(keyOf(b)) ?? 0 }));
  return {
    ok: true,
    result,
    footprint: {
      blocks: mine.map((b) => ({ section: b.section, text: b.text })),
      gone: afterLines.length ? [] : gone,
    },
  };
}
