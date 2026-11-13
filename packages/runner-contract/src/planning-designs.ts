// System design previews (spec 22 part B): what the runner's checks hand the cloud with a design
// revision, and what the app draws. The preview is a static SVG this repo's own code drew on the
// runner (no design text is executed anywhere), with the box of every part (a table, a box, an
// arrow, a message…) so the app can highlight what changed against the pulled base and pin comments
// on a part, and the layout warnings the save carried. The app shows the SVG only as an image; the
// cloud refuses one with scripts, event attributes, foreign content or outside references anyway.
// Runtime-neutral.
import { z } from "zod";

/** What a part of a design is. */
export const DESIGN_PART_KINDS = [
  "table",
  "enum",
  "relation",
  "box",
  "edge",
  "participant",
  "message",
  "state",
  "transition",
  "endpoint",
  "schema",
] as const;
export type DesignPartKind = (typeof DESIGN_PART_KINDS)[number];

const box = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
});

/**
 * A part of a drawn design. `id` is stable across revisions (`table users`, `box api.worker`,
 * `edge api -> db #1`, `GET /users`), so two revisions compare by it: a part only in the newer one
 * was added, only in the base removed, and in both with another `sig` changed.
 */
export const designPartSchema = z.object({
  id: z.string().min(1).max(300),
  kind: z.enum(DESIGN_PART_KINDS),
  /** How a person reads it: the table's name, the box's label, the arrow's label. */
  label: z.string().max(300),
  /** A short hash of what the part says (columns, label, ends): differs when the part changed. */
  sig: z.string().max(64),
  /** Where it is drawn, in the SVG's own units; null when it isn't drawn on its own. */
  box: box.nullable(),
});
export type DesignPart = z.output<typeof designPartSchema>;

/** A check's finding: an error refuses the save, a warning is saved with it. */
export const designFindingSchema = z.object({
  code: z.string().max(60),
  message: z.string().max(2_000),
  /** 1-based, when the parser said where. */
  line: z.number().int().positive().nullable().default(null),
  column: z.number().int().positive().nullable().default(null),
  /** The source line itself. */
  text: z.string().max(500).optional(),
  /** The parts it is about (ids). */
  parts: z.array(z.string().max(300)).max(10).default([]),
  fixes: z.array(z.string().max(500)).max(5).default([]),
});
export type DesignFinding = z.output<typeof designFindingSchema>;

/** The most a preview's SVG may hold; with the source it must fit one revision row. */
export const DESIGN_PREVIEW_MAX_BYTES = 500_000;

/** The one mark on the root of every preview the factory draws (an attribute the allow-list keeps). */
export const DRAWN_BY = 'data-drawn-by="software-factory"';

/**
 * The elements and attributes a preview may hold: exactly what `packages/planning-designs` draws.
 * Anything else, any prefixed (namespaced) name, comments, CDATA, processing instructions and
 * doctypes are refused (review of #163: a regex over the whole text both let `<s:script>` through
 * and refused escaped labels that mention `onload=` or `url(`).
 */
const SVG_ELEMENTS = new Set([
  "svg",
  "defs",
  "marker",
  "path",
  "rect",
  "text",
  "ellipse",
  "circle",
]);
const SVG_ATTRIBUTES = new Set([
  "xmlns",
  "data-drawn-by",
  "width",
  "height",
  "viewBox",
  "id",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "orient",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "marker-end",
  "x",
  "y",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
]);
const SVG_NS = "http://www.w3.org/2000/svg";

/** Why an SVG can't be stored and shown, or null: a tokeniser over an allow-list. */
export function unsafeSvg(svg: string): string | null {
  const text = svg.trim();
  if (!text.startsWith("<svg")) return "it doesn't start with <svg";
  const tag = /<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const open: string[] = [];
  let i = 0;
  let roots = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    // Text holds only escaped characters: the five named entities (exactly) and numeric ones.
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(chunk))
      return "its text has a bare & or an unknown entity";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(chunk))
      return "its text has control characters";
    if (lt === -1) break;
    if (open.length === 0 && roots > 0) return "it has something after its root";
    tag.lastIndex = lt;
    const m = tag.exec(text);
    if (!m) return "it holds markup that isn't a plain element (a comment, CDATA, a doctype…)";
    const [whole, close, name = "", attrs = "", self] = m;
    if (name.includes(":")) return `it has a prefixed element <${name}>`;
    if (!SVG_ELEMENTS.has(name)) return `it has a <${name}> element`;
    if (close) {
      if (attrs || self) return `its closing </${name}> has attributes`;
      if (open.pop() !== name) return `</${name}> closes an element it didn't open`;
    } else {
      if (open.length === 0) {
        if (++roots > 1) return "it has more than one root";
        if (name !== "svg") return "its root isn't <svg>";
      }
      const seen = new Set<string>();
      for (const a of attrs.matchAll(attr)) {
        const key = a[1] ?? "";
        const value = a[2] ?? a[3] ?? "";
        if (key.includes(":")) return `it has a prefixed attribute ${key}`;
        if (!SVG_ATTRIBUTES.has(key)) return `it has a ${key} attribute`;
        if (seen.has(key)) return `it repeats the ${key} attribute`;
        seen.add(key);
        // No entity or escape can spell something else inside a value (`&#117;rl(`, `\75 rl(`).
        if (/[&\\<]/.test(value)) return "an attribute holds an entity, an escape or markup";
        if (key === "xmlns" && value !== SVG_NS) return "it declares another namespace";
        if (/url\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value))
          return "it refers to something outside itself";
      }
      if (open.length === 0 && !seen.has("xmlns"))
        return "its root doesn't declare the SVG namespace";
      if (!self) open.push(name);
    }
    i = lt + whole.length;
  }
  return open.length === 0 ? null : "its elements don't close";
}

export const designPreviewSchema = z.object({
  svg: z
    .string()
    .min(1)
    .max(DESIGN_PREVIEW_MAX_BYTES)
    .superRefine((svg, ctx) => {
      const why = unsafeSvg(svg);
      if (why) ctx.addIssue({ code: "custom", message: `the preview can't be shown: ${why}` });
    }),
  width: z.number().finite().positive().max(100_000),
  height: z.number().finite().positive().max(100_000),
  parts: z.array(designPartSchema).max(1_000),
  warnings: z.array(designFindingSchema).max(20).default([]),
  /** SHA-256 (hex) of the source it was drawn from: the cloud stores it only with that source. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignPreview = z.output<typeof designPreviewSchema>;

/** How a part compares with the pulled base. */
export type PartChange = "added" | "changed" | "removed";

/** What changed between the base's parts and the current ones, by part id. */
export function compareParts(
  base: DesignPart[],
  current: DesignPart[],
): { changes: Map<string, PartChange>; removed: DesignPart[] } {
  const before = new Map(base.map((p) => [p.id, p]));
  const now = new Set(current.map((p) => p.id));
  const changes = new Map<string, PartChange>();
  for (const p of current) {
    const was = before.get(p.id);
    if (!was) changes.set(p.id, "added");
    else if (was.sig !== p.sig) changes.set(p.id, "changed");
  }
  const removed = base.filter((p) => !now.has(p.id));
  for (const p of removed) changes.set(p.id, "removed");
  return { changes, removed };
}

/**
 * A design's `.svg` beside it in `.kim/designs/`: its own path plus `.svg` (`system.d2.svg`), so two
 * designs never share one and the name doesn't depend on order (review of #163).
 */
export const designSvgPath = (path: string) => `${path}.svg`;
