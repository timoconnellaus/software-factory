// A layered layout (dagre) for the designs this package lays out itself: the data model's tables
// and the state diagram's states. D2 lays out its own designs.
import { Graph, layout } from "@dagrejs/dagre";
import type { Point } from "./layout.ts";

export interface GraphNode {
  id: string;
  w: number;
  h: number;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Room for a label on the edge. */
  label?: { w: number; h: number };
}

export interface Placed {
  nodes: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: Map<string, { points: Point[]; label: Point | null }>;
  width: number;
  height: number;
}

export function placeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { direction?: "TB" | "LR"; margin?: number; nodesep?: number; ranksep?: number } = {},
): Placed {
  const g = new Graph({ multigraph: true });
  const margin = opts.margin ?? 24;
  g.setGraph({
    rankdir: opts.direction ?? "TB",
    nodesep: opts.nodesep ?? 48,
    ranksep: opts.ranksep ?? 64,
    marginx: margin,
    marginy: margin,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.w, height: n.h });
  for (const e of edges) {
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
    g.setEdge(
      e.from,
      e.to,
      e.label ? { width: e.label.w, height: e.label.h, labelpos: "c" } : {},
      e.id,
    );
  }
  layout(g);
  const placed: Placed = { nodes: new Map(), edges: new Map(), width: 0, height: 0 };
  for (const n of nodes) {
    const v = g.node(n.id) as { x: number; y: number; width: number; height: number };
    placed.nodes.set(n.id, {
      x: v.x - v.width / 2,
      y: v.y - v.height / 2,
      w: v.width,
      h: v.height,
    });
  }
  for (const e of edges) {
    const v = g.edge({ v: e.from, w: e.to, name: e.id }) as
      | { points?: Point[]; x?: number; y?: number }
      | undefined;
    if (!v?.points) continue;
    placed.edges.set(e.id, {
      points: v.points,
      label: e.label && v.x !== undefined && v.y !== undefined ? { x: v.x, y: v.y } : null,
    });
  }
  const info = g.graph() as { width?: number; height?: number };
  placed.width = Math.max(info.width ?? 0, 2 * margin);
  placed.height = Math.max(info.height ?? 0, 2 * margin);
  return placed;
}
