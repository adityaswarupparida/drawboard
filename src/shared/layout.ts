import { NODE_H, NODE_W, type DiagramEdge, type DiagramNode } from "./diagram";

const GAP_X = 96;
const GAP_Y = 52;
const STEP_X = NODE_W + GAP_X;
const STEP_Y = NODE_H + GAP_Y;

type Pos = { x: number; y: number };
type NodeLike = Pick<DiagramNode, "id" | "x" | "y">;
type EdgeLike = Pick<DiagramEdge, "source" | "target">;

/**
 * Simple layered (left-to-right) layout. Deterministic and dependency-free,
 * so the server and the browser produce the same positions.
 */
export function layeredLayout(nodes: NodeLike[], edges: EdgeLike[]): Map<string, Pos> {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inc.set(id, []);
  }
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target) || e.source === e.target) continue;
    out.get(e.source)!.push(e.target);
    inc.get(e.target)!.push(e.source);
  }

  // Longest-path layering with Kahn's algorithm. Nodes stuck in cycles are
  // placed one layer after their deepest already-placed predecessor.
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, inc.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of out.get(id)!) {
      layer.set(t, Math.max(layer.get(t) ?? 0, layer.get(id)! + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  for (const id of ids) {
    if (layer.has(id)) continue;
    const preds = inc.get(id)!.filter((p) => layer.has(p));
    layer.set(id, preds.length ? Math.max(...preds.map((p) => layer.get(p)!)) + 1 : 0);
  }

  // Group into columns, then order each column by the average row of its predecessors.
  const columns: string[][] = [];
  for (const id of ids) {
    const l = layer.get(id)!;
    (columns[l] ??= []).push(id);
  }
  const row = new Map<string, number>();
  columns.forEach((col, ci) => {
    if (ci > 0) {
      const score = (id: string) => {
        const ps = inc.get(id)!.filter((p) => row.has(p));
        return ps.length ? ps.reduce((s, p) => s + row.get(p)!, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => score(a) - score(b));
    }
    col.forEach((id, i) => row.set(id, i - (col.length - 1) / 2));
  });

  const result = new Map<string, Pos>();
  columns.forEach((col, ci) =>
    col.forEach((id) => result.set(id, { x: ci * STEP_X, y: Math.round(row.get(id)! * STEP_Y) })),
  );
  return result;
}

function overlaps(p: Pos, others: NodeLike[]): boolean {
  const m = 20;
  return others.some(
    (o) => Math.abs(o.x - p.x) < NODE_W + m && Math.abs(o.y - p.y) < NODE_H + m,
  );
}

/** Finds a free spot for a new node next to something it is connected to. */
export function placeNear(nodeId: string, placed: NodeLike[], edges: EdgeLike[]): Pos {
  const byId = new Map(placed.map((n) => [n.id, n]));
  let base: Pos | null = null;
  for (const e of edges) {
    if (e.target === nodeId && byId.has(e.source)) {
      const s = byId.get(e.source)!;
      base = { x: s.x + STEP_X, y: s.y };
      break;
    }
    if (e.source === nodeId && byId.has(e.target)) {
      const t = byId.get(e.target)!;
      base = { x: t.x - STEP_X, y: t.y };
      break;
    }
  }
  if (!base) {
    if (!placed.length) return { x: 0, y: 0 };
    const maxX = Math.max(...placed.map((n) => n.x));
    const minY = Math.min(...placed.map((n) => n.y));
    base = { x: maxX + STEP_X, y: minY };
  }
  for (let ring = 0; ring < 12; ring++) {
    const candidates: Pos[] = ring === 0
      ? [base]
      : [
          { x: base.x, y: base.y + ring * STEP_Y },
          { x: base.x, y: base.y - ring * STEP_Y },
          { x: base.x + STEP_X, y: base.y + (ring - 1) * STEP_Y },
        ];
    for (const c of candidates) if (!overlaps(c, placed)) return c;
  }
  return { x: base.x, y: base.y + 13 * STEP_Y };
}
