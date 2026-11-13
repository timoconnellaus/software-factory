// Showing a design's preview (spec 22 part B). The SVG was drawn on the runner by the factory's own
// code from untrusted design text; the app shows it only as an image (`<img>` with a data URL), so
// no script in it runs and nothing outside it loads, whatever it holds (ADR 0472's isolation).
import {
  compareParts,
  type DesignPart,
  type DesignPreview,
  type PartChange,
} from "@software-factory/client/planning";

/** The SVG as an image source. */
export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A part drawn over the preview: where, what changed, and its pins. */
export interface Overlay {
  part: DesignPart;
  box: NonNullable<DesignPart["box"]>;
  change: Exclude<PartChange, "removed"> | null;
}

/**
 * What to draw over a design's preview: each part with a box, marked added or changed against the
 * pulled base when there is one; and the parts the base had that are gone. Without a base (a design
 * the planner made), nothing is marked.
 */
export function designOverlays(
  preview: DesignPreview,
  base: DesignPreview | null,
): { overlays: Overlay[]; removed: DesignPart[]; counts: Record<PartChange, number> } {
  const counts: Record<PartChange, number> = { added: 0, changed: 0, removed: 0 };
  if (!base) {
    return {
      overlays: preview.parts.flatMap((part) =>
        part.box ? [{ part, box: part.box, change: null }] : [],
      ),
      removed: [],
      counts,
    };
  }
  const { changes, removed } = compareParts(base.parts, preview.parts);
  for (const c of changes.values()) counts[c] += 1;
  const overlays: Overlay[] = [];
  for (const part of preview.parts) {
    if (!part.box) continue;
    const c = changes.get(part.id);
    overlays.push({ part, box: part.box, change: c === "added" || c === "changed" ? c : null });
  }
  return { overlays, removed, counts };
}

/** A pin on a part, from a click at (x, y) in the preview's own units (spec 22, criterion 2). */
export function pinOnPart(
  artifactId: string,
  preview: Pick<DesignPreview, "width">,
  part: Pick<DesignPart, "id" | "box">,
  at: { x: number; y: number },
) {
  const box = part.box ?? { x: at.x, y: at.y, w: 1, h: 1 };
  const frac = (v: number, from: number, size: number) =>
    size > 0 ? Math.min(1, Math.max(0, (v - from) / size)) : 0.5;
  return {
    artifactId,
    element: part.id,
    selector: null,
    x: at.x,
    y: at.y,
    fx: frac(at.x, box.x, box.w),
    fy: frac(at.y, box.y, box.h),
    width: preview.width,
  };
}

/** Where a pin sits now: on its part's box if the part is still drawn, else where it was put. */
export function pinPlace(
  pin: { element: string; x: number; y: number; fx: number; fy: number },
  parts: DesignPart[],
): { x: number; y: number } {
  const box = parts.find((p) => p.id === pin.element)?.box;
  return box ? { x: box.x + pin.fx * box.w, y: box.y + pin.fy * box.h } : { x: pin.x, y: pin.y };
}
