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

/**
 * Why an SVG can't be shown, or null (defence in depth: the app shows it as an image, where none
 * of these would run or load, but the cloud keeps them out of the record too).
 */
export function unsafeSvg(svg: string): string | null {
  if (!/^<svg[\s>]/.test(svg.trimStart())) return "it doesn't start with <svg";
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg)) return "it declares a doctype or entity";
  if (
    /<\s*(script|foreignObject|iframe|object|embed|image|use|a|style|animate\w*|set)\b/i.test(svg)
  )
    return "it holds a script, foreign content, an image, a link or a style element";
  if (/\son\w+\s*=/i.test(svg)) return "it has an event attribute";
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg)) return "it links outside itself";
  if (/url\(\s*["']?(?!#)/i.test(svg)) return "it refers to something outside itself";
  if (/@import|javascript:/i.test(svg)) return "it imports or runs something";
  return null;
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

/** A design's `.svg` beside it in `.kim/designs/` (kim's naming: the extension replaced). */
export const designSvgPath = (path: string) => `${path.replace(/\.[^./]+$/, "")}.svg`;
