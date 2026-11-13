// The plan's blocks (spec 27, ADR 0471, reviews of #85): ONE segmentation of a plan's Markdown,
// used by the server (which edits are kept, comment anchors) and by the app (which renders the plan
// block by block from it, so a block on screen is by construction a block on the server).
//
// A block is a heading (ATX or setext), a list item (with its lazy continuation lines), a paragraph
// or a fenced code block. A nested list item, and a paragraph or fence inside a list item, are blocks
// of their own, indented, and know their parent item. Each block knows its section: the path of
// headings above it, with repeated headings told apart ("Notes", "Notes (2)"). A person's edit is
// kept by section, parent and count (a multiset), so moving a line to another section or under
// another item, or deleting the person's copy of a duplicated line, doesn't count as keeping it.

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
  /** The list item it sits in (its text), "" at the top level. */
  parent: string;
  /** The first line's indent, in columns: how deep in a list it sits. */
  indent: number;
  /** An ordered item's number in its list (1. 1. 1. reads 1, 2, 3); null otherwise. */
  ordinal: number | null;
  /** A heading's own section path: the section of the blocks under it. Null for other blocks. */
  opens: string | null;
  /** 0-based source lines, inclusive. */
  lineStart: number;
  lineEnd: number;
}

/** Folds runs of space: the comparison is word for word, not byte for byte. */
export const foldSpace = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line ending: a plan written with CRLF reads as one written with LF. */
export const normalizeLines = (md: string) => md.replace(/\r\n?/g, "\n");

const LIST_ITEM = /^( *)([-*+]|(\d{1,9})[.)])( +|$)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const FENCE_OPEN = /^( *)(`{3,}|~{3,})(.*)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const expandTabs = (line: string) => line.replace(/\t/g, "    ");

/** Removes up to `n` columns of leading space from each line. */
export function dedent(lines: string[], n: number): string[] {
  return lines.map((l) => l.replace(new RegExp(`^ {0,${n}}`), ""));
}

/** A plan's blocks, in order. */
export function planBlocks(md: string): PlanBlock[] {
  const lines = normalizeLines(md).split("\n").map(expandTabs);
  const out: (PlanBlock & { parentAt: number | null })[] = [];
  const headings: { level: number; name: string }[] = [];
  const seen = new Map<string, number>();
  const section = () => headings.map((h) => h.name).join(" › ");
  let headingSection = "";
  type Open = {
    kind: PlanBlock["kind"];
    lines: string[];
    start: number;
    indent: number;
    parentAt: number | null;
    ordinal: number | null;
    opens?: string;
  };
  let current: Open | null = null;
  // Open list items, innermost last: where nested blocks find their parent and ordinals continue.
  let items: { indent: number; at: number; ordered: boolean; ordinal: number | null }[] = [];
  // The content column of the list item we're in, for fences inside it; null outside a list.
  let itemCol: number | null = null;
  let afterBlank = true;
  let fence: { char: string; len: number; indent: number } | null = null;

  const parentFor = (indent: number) => {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (it && it.indent < indent) return it.at;
    }
    return null;
  };
  const close = (end: number) => {
    if (!current) return;
    const c: Open = current;
    current = null;
    const text =
      c.kind === "fence"
        ? dedent(c.lines, c.indent)
            .map((l) => l.trimEnd())
            .join("\n")
        : foldSpace(c.lines.join("\n"));
    out.push({
      kind: c.kind,
      text,
      section: c.kind === "heading" ? headingSection : section(),
      parent: "",
      parentAt: c.parentAt,
      indent: c.indent,
      ordinal: c.ordinal,
      opens: c.opens ?? null,
      lineStart: c.start,
      lineEnd: end,
    });
  };
  const enterHeading = (level: number, name: string) => {
    while (headings.length && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
    headingSection = section();
    // A repeated heading under the same parent is told apart by its place: "Notes", "Notes (2)".
    const key = `${headingSection}␟${name}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? name : `${name} (${n})`;
  };

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
    // A setext underline turns the paragraph above into a heading (and a section).
    const setext = SETEXT.exec(line);
    if (
      setext &&
      current?.kind === "paragraph" &&
      current.indent <= 3 &&
      current.parentAt === null
    ) {
      const c: Open = current;
      const level = setext[1]?.startsWith("=") ? 1 : 2;
      const name = enterHeading(level, foldSpace(c.lines.join(" ")));
      c.kind = "heading";
      c.lines.push(line);
      headings.push({ level, name });
      c.opens = section();
      headings.pop();
      close(i);
      headings.push({ level, name });
      items = [];
      itemCol = null;
      afterBlank = false;
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
      current = {
        kind: "fence",
        lines: [line],
        start: i,
        indent,
        parentAt: indent > 0 ? parentFor(indent) : null,
        ordinal: null,
      };
      afterBlank = false;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading && indent <= 3) {
      close(i - 1);
      const level = heading[1]?.length ?? 1;
      const name = enterHeading(level, foldSpace(heading[2] ?? "").replace(/\s#+$/, ""));
      headings.push({ level, name });
      const opens = section();
      headings.pop();
      current = {
        kind: "heading",
        lines: [line],
        start: i,
        indent,
        parentAt: null,
        ordinal: null,
        opens,
      };
      close(i);
      headings.push({ level, name });
      items = [];
      itemCol = null;
      afterBlank = false;
      return;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      close(i - 1);
      itemCol = (item[1]?.length ?? 0) + (item[2]?.length ?? 1) + Math.max(1, item[4]?.length ?? 1);
      // Close deeper items; a sibling at this indent continues the list's numbering.
      let sibling: (typeof items)[number] | undefined;
      while (items.length && (items.at(-1)?.indent ?? 0) >= indent) {
        const popped = items.pop();
        if (popped && popped.indent === indent) sibling = popped;
      }
      const ordered = item[3] !== undefined;
      const ordinal = ordered
        ? sibling?.ordered && sibling.ordinal !== null
          ? sibling.ordinal + 1
          : Number(item[3])
        : null;
      current = {
        kind: "item",
        lines: [line],
        start: i,
        indent,
        parentAt: parentFor(indent),
        ordinal,
      };
      items.push({ indent, at: out.length, ordered, ordinal });
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
    if (afterBlank && itemCol !== null && indent < Math.min(itemCol, 2)) {
      itemCol = null;
      items = [];
    }
    current = {
      kind: "paragraph",
      lines: [line],
      start: i,
      indent,
      parentAt: indent > 0 && itemCol !== null ? parentFor(indent) : null,
      ordinal: null,
    };
    afterBlank = false;
  });
  close(lines.length - 1);
  return out.map(({ parentAt, ...b }) => ({
    ...b,
    parent: parentAt !== null ? (out[parentAt]?.text ?? "") : "",
  }));
}

/** A block's identity for keeping edits: its section, its parent item and its text. */
export interface PlanKey {
  section: string;
  /** The item it sits in; "" (or absent, for edits stored before parents) at the top level. */
  parent?: string;
  text: string;
}

/** What a person's edit asks the planner to keep (stored with the edit). */
export interface EditFootprint {
  /** Blocks the edit wrote: each must stay, in its section and under its parent, as often as written. */
  blocks: PlanKey[];
  /**
   * Blocks the edit removed (deleted or replaced): no more blocks of its section may say it than the
   * edit left (`max`), so the planner can't put the old line back, even inside a longer one.
   */
  gone: (PlanKey & { max: number })[];
}

const keyOf = (k: PlanKey) => `${k.section}␟${k.parent ?? ""}␟${k.text}`;

/** A block's words without its list marker. */
const content = (text: string) => text.replace(/^([-*+]|\d{1,9}[.)])\s+/, "").trim();

/**
 * How many blocks of a section are `text` exactly (fourth review of #85): a removed block counts
 * only as a whole block; a longer line that mentions it is the planner's to write, and is listed to
 * the person (`mentions`), not refused.
 */
function exactly(blocks: PlanBlock[], section: string, text: string): number {
  const said = sayingOf(text);
  return blocks.filter((b) => b.section === section && sayingOf(b.text) === said).length;
}

/**
 * What a removed block says, for keeping it out (review of #85): case, spacing and the list marker
 * aside, so "- mysql" or "* MySQL" can't bring back a removed "- MySQL". A fence compares exactly.
 */
const sayingOf = (text: string) =>
  /^\s*(```|~~~)/.test(text) ? text : foldSpace(content(text)).toLowerCase();

/** How many times each block (section, parent and text) appears in a plan. */
export function planCounts(md: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of planBlocks(md)) counts.set(keyOf(b), (counts.get(keyOf(b)) ?? 0) + 1);
  return counts;
}

/**
 * The edits a plan doesn't keep. Edits are taken in order and each takes the copies it needs, so two
 * edits that both wrote "- TBD" in a section need two of them. What an edit removed is kept out
 * while no more blocks of its section are exactly it than the edit left.
 */
export function droppedEdits<E extends { footprint: EditFootprint }>(md: string, edits: E[]): E[] {
  const blocks = planBlocks(md);
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(keyOf(b), (counts.get(keyOf(b)) ?? 0) + 1);
  const used = new Map<string, number>();
  return edits.filter((e) => {
    const need = new Map<string, number>();
    for (const b of e.footprint.blocks) need.set(keyOf(b), (need.get(keyOf(b)) ?? 0) + 1);
    const writes = [...need].every(([k, n]) => (counts.get(k) ?? 0) - (used.get(k) ?? 0) >= n);
    const removed = e.footprint.gone.every((g) => exactly(blocks, g.section, g.text) <= g.max);
    if (!writes || !removed) return true;
    for (const [k, n] of need) used.set(k, (used.get(k) ?? 0) + n);
    return false;
  });
}

/** Words in common, for naming the block the planner wrote in place of a person's. */
const overlap = (a: string, b: string) => {
  const words = (t: string) =>
    content(t)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const w = new Set(words(a));
  return words(b).filter((x) => w.has(x)).length;
};

/**
 * Why a plan doesn't keep an edit, exactly enough for the planner to undo what broke it: which
 * block is missing from which section (and what stands nearest in its place), or which removed
 * block is back.
 */
export function whyNotKept(md: string, footprint: EditFootprint): string {
  const blocks = planBlocks(md);
  // A section exists while its heading does, even with nothing under it.
  const sections = new Set([
    ...blocks.map((b) => b.section),
    ...blocks.flatMap((b) => (b.opens !== null ? [b.opens] : [])),
  ]);
  const lost = [...footprint.blocks, ...footprint.gone].find(
    (k) => k.section && !sections.has(k.section),
  );
  if (lost) return `its section "${lost.section}" is no longer in the plan`;
  const back = footprint.gone.find((g) => exactly(blocks, g.section, g.text) > g.max);
  if (back)
    return `"${content(back.text)}", which it removed, is back in ${back.section || "the plan"}`;
  const missing = footprint.blocks.find(
    (k) =>
      !blocks.some(
        (b) => b.section === k.section && b.text === k.text && b.parent === (k.parent ?? b.parent),
      ),
  );
  if (missing) {
    const near = blocks
      .filter((b) => b.section === missing.section)
      .map((b) => ({ b, n: overlap(missing.text, b.text) }))
      .sort((x, y) => y.n - x.n)[0];
    const moved = blocks.find((b) => b.text === missing.text);
    if (moved) {
      return `"${content(missing.text)}" moved: it belongs in ${missing.section || "the top of the plan"}${missing.parent ? ` under "${content(missing.parent)}"` : ""}, and is now in ${moved.section || "the top of the plan"}${moved.parent ? ` under "${content(moved.parent)}"` : ""}`;
    }
    return `"${content(missing.text)}" is missing from ${missing.section || "the plan"}${near && near.n > 0 ? `; the plan has "${content(near.b.text)}" there instead` : ""}`;
  }
  return "the plan doesn't have its words as written, in their place";
}

/**
 * Lines of the plan that mention what an edit removed without being it (fourth review of #85): the
 * planner may write them; the person sees them under the plan, with Release or Keep.
 */
export function mentions(md: string, footprint: EditFootprint): string[] {
  const blocks = planBlocks(md);
  const out: string[] = [];
  for (const g of footprint.gone) {
    const said = content(g.text);
    if (!said) continue;
    const escaped = said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu");
    for (const b of blocks) {
      if (b.section === g.section && b.text !== g.text && re.test(content(b.text)))
        out.push(b.text);
    }
  }
  return [...new Set(out)];
}

/** Whether a rendered block is one an edit wrote (same section, parent and text). */
export function editWrote(footprint: EditFootprint, block: PlanKey): boolean {
  return footprint.blocks.some((b) => keyOf(b) === keyOf(block));
}

/**
 * How a person's edit of lines `lineStart..lineEnd` (now `count` lines) moved the plan's other
 * blocks (fourth review of #85): every block outside the edited lines is the same block after, at
 * the same place (shifted by the change in length), but its section or parent may have changed: a
 * heading renamed, inserted, deleted or reordered above it ("Notes" becoming "Notes (2)"), or its
 * parent item reworded. Returns the key, section and parent maps from before to after.
 */
export function structureMoves(
  before: string,
  after: string,
  lineStart: number,
  lineEnd: number,
  count: number,
): { keys: Map<string, PlanKey>; sections: Map<string, string>; parents: Map<string, string> } {
  const delta = count - (lineEnd - lineStart + 1);
  const at = new Map(planBlocks(after).map((b) => [b.lineStart, b]));
  const keys = new Map<string, PlanKey>();
  const sections = new Map<string, string>();
  const parents = new Map<string, string>();
  for (const b of planBlocks(before)) {
    if (b.lineEnd >= lineStart && b.lineStart <= lineEnd) continue;
    const a = at.get(b.lineStart < lineStart ? b.lineStart : b.lineStart + delta);
    if (!a || a.text !== b.text) continue;
    const k = keyOf(b);
    if (!keys.has(k)) keys.set(k, { section: a.section, parent: a.parent, text: a.text });
    if (b.section !== a.section && !sections.has(b.section)) sections.set(b.section, a.section);
    if (b.parent && b.parent !== a.parent && !parents.has(b.parent))
      parents.set(b.parent, a.parent);
  }
  return { keys, sections, parents };
}

/** A footprint carried along by `structureMoves` (a person's edit moved what it is keyed to). */
export function rekeyFootprint(
  footprint: EditFootprint,
  moves: ReturnType<typeof structureMoves>,
): EditFootprint {
  const section = (s: string) => moves.sections.get(s) ?? s;
  const parent = (p: string | undefined) => (p ? (moves.parents.get(p) ?? p) : p);
  return {
    blocks: footprint.blocks.map((k) => {
      const moved = moves.keys.get(keyOf(k));
      return moved
        ? { ...k, ...moved }
        : { ...k, section: section(k.section), parent: parent(k.parent) };
    }),
    gone: footprint.gone.map((k) => ({
      ...k,
      section: section(k.section),
      parent: parent(k.parent),
    })),
  };
}

/** Whether a footprint changed (so its stored copy needs writing). */
export const sameFootprint = (a: EditFootprint, b: EditFootprint) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Words without the edges' punctuation, spaces folded, lowercased: how an answer compares. */
const plain = (t: string) =>
  foldSpace(t)
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * What an edit changed on the line carrying `tag`: the words of the new line between the words it
 * shares with the old line at the start and at the end. Null when no line carries the tag.
 */
export function changedSpan(before: string, after: string, tag: string): string | null {
  const line = (t: string) =>
    t
      .split("\n")
      .find((l) => l.includes(tag))
      ?.replace(tag, " ")
      .replace(/^\s*([-*+]|\d+[.)])\s+/, "");
  const b = line(before)?.split(/\s+/).filter(Boolean);
  const a = line(after)?.split(/\s+/).filter(Boolean);
  if (!a || !b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return a.slice(start, a.length - end).join(" ");
}

/**
 * The answer an edit gives a question, or null (fourth review of #85: no reading of meaning). The
 * changed span, trimmed, must BE one of the question's options (case and surrounding punctuation
 * aside), or, for a question with no options, the answer is the whole changed span as written. Any
 * other edit answers nothing: the person is asked to confirm with one tap.
 */
export function editAnswer(span: string | null, options: string[]): string | null {
  if (!span || !plain(span)) return null;
  if (options.length === 0) return span.trim().replace(/^[,;:\s]+|[,;:\s]+$/g, "");
  const matches = options.filter((o) => plain(o) === plain(span));
  if (matches.length <= 1) return matches[0] ?? null;
  // Options that differ only by punctuation or case ("C", "C#"; "Go", "Go!") need the span to be
  // one of them exactly, after trimming; otherwise nothing is picked and the person is asked.
  return matches.find((o) => o.trim() === span.trim()) ?? null;
}

/**
 * What an edit of lines `lineStart..lineEnd` of `body` to `after` keeps, or why it can't be kept.
 * The lines must be whole blocks of the plan, and `after` must be the same blocks in the resulting
 * plan as on its own: an unclosed fence that swallows what follows, or a line that loses its list
 * marker and joins the item above, isn't the edit the person saw. Only the blocks that changed are
 * the person's: an untouched neighbour inside the edited lines stays the planner's.
 */
export function editFootprint(
  body: string,
  lineStart: number,
  lineEnd: number,
  after: string,
): { ok: true; result: string; footprint: EditFootprint } | { ok: false; reason: string } {
  const lines = normalizeLines(body).split("\n");
  const before = planBlocks(lines.join("\n"));
  const inRange = (b: PlanBlock, s: number, e: number) => b.lineEnd >= s && b.lineStart <= e;
  const touched = before.filter((b) => inRange(b, lineStart, lineEnd));
  if (touched.some((b) => b.lineStart < lineStart || b.lineEnd > lineEnd)) {
    return { ok: false, reason: "edit whole blocks of the plan: a line, a list item or a fence" };
  }
  const afterText = normalizeLines(after);
  const afterLines = afterText.trim() === "" ? [] : afterText.split("\n");
  const result = [...lines.slice(0, lineStart), ...afterLines, ...lines.slice(lineEnd + 1)].join(
    "\n",
  );
  const blocks = planBlocks(result);
  const end = lineStart + afterLines.length - 1;
  const mine = afterLines.length ? blocks.filter((b) => inRange(b, lineStart, end)) : [];
  // Read alone, without the list it sits in: its lines dedented by their least indent.
  const least = Math.min(
    ...afterLines.filter((l) => l.trim()).map((l) => indentOf(expandTabs(l))),
    Number.POSITIVE_INFINITY,
  );
  const alone = planBlocks(
    dedent(afterLines.map(expandTabs), Number.isFinite(least) ? least : 0).join("\n"),
  );
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
  // Only what changed: blocks written that weren't there, and blocks that were there and went.
  const unmatched = (from: PlanBlock[], against: PlanBlock[]) => {
    const pool = against.map((b) => b.text);
    return from.filter((b) => {
      const k = pool.indexOf(b.text);
      if (k === -1) return true;
      pool.splice(k, 1);
      return false;
    });
  };
  const wrote = unmatched(mine, touched);
  const removed = unmatched(touched, mine);
  return {
    ok: true,
    result,
    footprint: {
      blocks: wrote.map((b) => ({ section: b.section, parent: b.parent, text: b.text })),
      gone: removed.map((b) => ({
        section: b.section,
        parent: b.parent,
        text: b.text,
        max: exactly(blocks, b.section, b.text),
      })),
    },
  };
}
