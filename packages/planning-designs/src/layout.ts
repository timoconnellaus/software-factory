// Layout checks (after kim's `design/layoutCheck.ts`): the warnings a design saves with. Text that
// would be too small to read when the drawing is fitted to a window, arrows that cross, and arrows
// that run through a box they don't connect.
import type { DesignFinding } from "@software-factory/runner-contract";

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Line {
  id: string;
  from: string;
  to: string;
  points: Point[];
}

/** The window a design is read in. */
export const FRAME = { w: 1280, h: 800 };
/** Below this many pixels, text fitted to the frame is too small to read. */
const READABLE_PX = 9;

/** A warning when the drawing's smallest text is too small once fitted to the frame, or null. */
export function readability(
  size: { w: number; h: number },
  smallestText: number,
  fixes: string[],
): DesignFinding | null {
  const scale = Math.min(1, FRAME.w / size.w, FRAME.h / size.h);
  const shown = smallestText * scale;
  if (shown >= READABLE_PX) return null;
  return {
    code: "layout/text-too-small",
    message: `Fitted to a ${FRAME.w}×${FRAME.h} window, its text would be ${shown.toFixed(1)}px: too small to read (it is ${Math.round(size.w)}×${Math.round(size.h)})`,
    line: null,
    column: null,
    parts: [],
    fixes: fixes.slice(0, 5),
  };
}

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Whether segments ab and cd properly cross (touching ends don't count). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const segments = (points: Point[]) =>
  points.slice(1).map((p, i) => [points[i] as Point, p] as const);

/** Whether a segment passes through a box's inside (shrunk a little, so grazing an edge is fine). */
function throughBox(a: Point, b: Point, box: Box): boolean {
  const pad = 4;
  const x0 = box.x + pad;
  const y0 = box.y + pad;
  const x1 = box.x + box.w - pad;
  const y1 = box.y + box.h - pad;
  if (x1 <= x0 || y1 <= y0) return false;
  const inside = (p: Point) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
  if (inside(a) || inside(b)) return true;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return segments([...corners, corners[0] as Point]).some(([c, d]) => segmentsCross(a, b, c, d));
}

/**
 * Crossing arrows and arrows through boxes, each naming the parts. `related` says a box is one of
 * an arrow's ends (or holds one); `shareEnd` that two arrows meet, so their crossing doesn't count.
 */
export function lineFindings(
  lines: Line[],
  boxes: Box[],
  opts: {
    related: (line: Line, box: Box) => boolean;
    shareEnd: (a: Line, b: Line) => boolean;
    fixes: { crossing: string[]; throughShape: string[] };
  },
): DesignFinding[] {
  const findings: DesignFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i] as Line;
      const b = lines[j] as Line;
      if (opts.shareEnd(a, b)) continue;
      const hit = segments(a.points).some(([p, q]) =>
        segments(b.points).some(([r, s]) => segmentsCross(p, q, r, s)),
      );
      if (hit) {
        findings.push({
          code: "layout/crossing",
          message: `\`${a.id}\` crosses \`${b.id}\``,
          line: null,
          column: null,
          parts: [a.id, b.id],
          fixes: opts.fixes.crossing,
        });
      }
    }
    const line = lines[i] as Line;
    for (const box of boxes) {
      if (opts.related(line, box)) continue;
      if (segments(line.points).some(([p, q]) => throughBox(p, q, box))) {
        findings.push({
          code: "layout/through-shape",
          message: `\`${line.id}\` runs through \`${box.id}\`, which it doesn't connect`,
          line: null,
          column: null,
          parts: [line.id, box.id],
          fixes: opts.fixes.throughShape,
        });
      }
    }
  }
  return findings;
}

/** Samples a curved route (D2's cubic Béziers: start, then control, control, end…) as points. */
export function sampleCurve(route: Point[]): Point[] {
  if (route.length < 4) return route;
  const out: Point[] = [route[0] as Point];
  for (let i = 0; i + 3 < route.length; i += 3) {
    const p0 = route[i] as Point;
    const p1 = route[i + 1] as Point;
    const p2 = route[i + 2] as Point;
    const p3 = route[i + 3] as Point;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      const at = (a: number, b: number, c: number, d: number) =>
        u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
      out.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

/** A short, stable hash of what a part says (FNV-1a), for comparing revisions. */
export function sig(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A small box around a route's middle, for an arrow to be pinned and highlighted. */
export function midBox(points: Point[]): { x: number; y: number; w: number; h: number } {
  const p = points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
  const q = points[Math.max(0, Math.floor(points.length / 2) - 1)] ?? p;
  const x = (p.x + q.x) / 2;
  const y = (p.y + q.y) / 2;
  return { x: x - 10, y: y - 10, w: 20, h: 20 };
}
