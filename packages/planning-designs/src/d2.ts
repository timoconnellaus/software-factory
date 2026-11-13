// Architecture and data-flow designs in D2 (spec 22): compiled with D2's own engine (wasm, dagre
// layout), then drawn here from its shapes and routes, so the preview is plain SVG and every box
// and arrow is a part. Layout warnings name the parts: crossing arrows, arrows through boxes, and
// text too small once fitted to a window (after kim's `designCheck.ts`).
import type { DesignFinding, DesignPart } from "@software-factory/runner-contract";
import {
  type Box,
  type Line,
  lineFindings,
  midBox,
  type Point,
  readability,
  sampleCurve,
  sig,
} from "./layout.ts";
import { INK, path, r1, rect, svgDocument, text } from "./svg.ts";
import type { Drawn } from "./types.ts";

interface D2Diagram {
  shapes: {
    id: string;
    type?: string;
    pos: Point;
    width: number;
    height: number;
    label?: string;
    fontSize?: number;
  }[];
  connections: {
    id?: string;
    src: string;
    dst: string;
    route: Point[];
    isCurve?: boolean;
    label?: string;
    fontSize?: number;
    labelWidth?: number;
    labelHeight?: number;
    strokeDash?: number;
  }[];
}

/** D2 runs as wasm in a worker thread, which is ended after each compile. */
async function compileD2(source: string): Promise<D2Diagram> {
  const { D2 } = await import("@terrastruct/d2");
  const d2 = new D2();
  try {
    const result = await d2.compile({ fs: { index: source }, options: { layout: "dagre" } });
    return result.diagram as unknown as D2Diagram;
  } finally {
    // Not in its types: the worker exists once `ready` resolves.
    const internals = d2 as unknown as {
      ready: Promise<unknown>;
      worker?: { terminate(): unknown };
    };
    await internals.ready.catch(() => undefined);
    await internals.worker?.terminate();
  }
}

const PAD = 24;
/** Whether `a` is `b`, or holds it (`a` is a container of `b`). */
const holds = (a: string, b: string) => a === b || b.startsWith(`${a}.`);

export async function drawD2(source: string): Promise<Drawn> {
  const diagram = await compileD2(source);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of diagram.shapes) {
    xs.push(s.pos.x, s.pos.x + s.width);
    ys.push(s.pos.y, s.pos.y + s.height);
  }
  for (const c of diagram.connections)
    for (const p of c.route) {
      xs.push(p.x);
      ys.push(p.y);
    }
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const width = (xs.length ? Math.max(...xs) - minX : 0) + 2 * PAD;
  const height = (ys.length ? Math.max(...ys) - minY : 0) + 2 * PAD;
  const at = (p: Point) => ({ x: p.x - minX + PAD, y: p.y - minY + PAD });

  const ids = diagram.shapes.map((s) => s.id);
  const containers = new Set(ids.filter((id) => ids.some((o) => o.startsWith(`${id}.`))));
  const depth = (id: string) => id.split(".").length;
  const parts: DesignPart[] = [];
  let body = "";
  // Containers first, outermost first, so what they hold draws on top.
  const shapes = [...diagram.shapes].sort(
    (a, b) =>
      Number(containers.has(b.id)) - Number(containers.has(a.id)) || depth(a.id) - depth(b.id),
  );
  for (const s of shapes) {
    const p = at(s.pos);
    const container = containers.has(s.id);
    const label = s.label ?? s.id.split(".").pop() ?? s.id;
    if (s.type === "circle" || s.type === "oval") {
      body += `<ellipse cx="${r1(p.x + s.width / 2)}" cy="${r1(p.y + s.height / 2)}" rx="${r1(s.width / 2)}" ry="${r1(s.height / 2)}" fill="${INK.card}" stroke="${INK.line}"/>`;
    } else {
      body += rect(p.x, p.y, s.width, s.height, {
        fill: container ? INK.head : INK.card,
        radius: container ? 10 : 6,
      });
    }
    body += container
      ? text(p.x + 12, p.y + 20, label, { size: 13, weight: 600, fill: INK.muted })
      : text(p.x + s.width / 2, p.y + s.height / 2 + 5, label, {
          size: s.fontSize ?? 14,
          anchor: "middle",
        });
    parts.push({
      id: `box ${s.id}`,
      kind: "box",
      label,
      sig: sig([label, s.type ?? "rectangle", container]),
      box: { x: p.x, y: p.y, w: s.width, h: s.height },
    });
  }
  const seen = new Map<string, number>();
  const lines: Line[] = [];
  for (const c of diagram.connections) {
    const key = `${c.src} -> ${c.dst}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const id = `edge ${key}${n > 1 ? ` #${n}` : ""}`;
    const route = (c.isCurve ? sampleCurve(c.route) : c.route).map(at);
    body += path(route, { dashed: (c.strokeDash ?? 0) > 0 });
    if (c.label) {
      const mid = midBox(route);
      body += `<rect x="${r1(mid.x + 10 - (c.labelWidth ?? 40) / 2 - 3)}" y="${r1(mid.y + 10 - (c.labelHeight ?? 16) / 2 - 2)}" width="${r1((c.labelWidth ?? 40) + 6)}" height="${r1((c.labelHeight ?? 16) + 4)}" rx="4" fill="${INK.panel}"/>`;
      body += text(mid.x + 10, mid.y + 14, c.label, {
        size: c.fontSize ?? 13,
        anchor: "middle",
        fill: INK.muted,
      });
    }
    lines.push({ id, from: c.src, to: c.dst, points: route });
    parts.push({
      id,
      kind: "edge",
      label: c.label || key,
      sig: sig([c.label ?? ""]),
      box: midBox(route),
    });
  }

  const boxes: Box[] = diagram.shapes
    .filter((s) => !containers.has(s.id))
    .map((s) => ({ id: `box ${s.id}`, ...at(s.pos), w: s.width, h: s.height }));
  const regroup =
    "Put the shapes involved in one container, or declare each shape next to the ones it connects to: the layout orders a row by declaration";
  const warnings: DesignFinding[] = [];
  const texts = [
    ...diagram.shapes.filter((s) => s.label).map((s) => s.fontSize ?? 16),
    ...diagram.connections.filter((c) => c.label).map((c) => c.fontSize ?? 16),
  ];
  const small = readability({ w: width, h: height }, Math.min(16, ...texts), [
    "Split it: keep this design to the overview and give a busy container a design of its own",
    "Group related shapes in containers, so fewer boxes sit side by side",
    "Try the other `direction` (D2 lays out down unless told `direction: right`)",
  ]);
  if (small) warnings.push(small);
  warnings.push(
    ...lineFindings(lines, boxes, {
      related: (line, box) => {
        const shape = box.id.slice("box ".length);
        return holds(shape, line.from) || holds(shape, line.to);
      },
      shareEnd: (a, b) =>
        [a.from, a.to].some((x) => [b.from, b.to].some((y) => holds(x, y) || holds(y, x))),
      fixes: {
        crossing: [regroup, "Try the other `direction` (right or down)"],
        throughShape: [regroup, "Connect to the container rather than a shape inside it"],
      },
    }),
  );
  return {
    svg: svgDocument(width, height, body),
    width,
    height,
    parts,
    warnings: warnings.slice(0, 20),
  };
}
