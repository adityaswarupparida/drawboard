import {
  KIND_LABEL,
  type AuthorRef,
  type Diagram,
  type DiagramNode,
  type Op,
} from "./diagram";
import { layeredLayout, placeNear } from "./layout";

export interface ApplyOptions {
  /** AI mode: may refer to nodes by label, and may reuse ids it invented earlier in the batch. */
  lenient?: boolean;
  newId: () => string;
}

export interface ApplyResult {
  diagram: Diagram;
  lines: string[];
  errors: string[];
  changed: boolean;
  addedNodeIds: string[];
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const q = (s: string) => `“${s}”`;

// Invalid ops are skipped (reported in `errors`) while the rest still apply.
// Must stay pure: the server and the client's optimistic preview both run it.
export function applyOps(input: Diagram, ops: Op[], by: AuthorRef, opts: ApplyOptions): ApplyResult {
  const d: Diagram = structuredClone(input);
  const lines: string[] = [];
  const errors: string[] = [];
  const idMap = new Map<string, string>();
  const unplaced: string[] = [];
  const addedNodeIds: string[] = [];
  const placedBefore = d.nodes.length;

  const takenIds = () => new Set([...d.nodes.map((n) => n.id), ...d.edges.map((e) => e.id)]);
  const freshId = (wanted?: string) => {
    const taken = takenIds();
    const base = wanted ? slug(wanted) : "";
    if (base && !taken.has(base)) return base;
    if (base) {
      for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
    let id = opts.newId();
    while (taken.has(id)) id = opts.newId();
    return id;
  };

  const findNode = (ref: string): DiagramNode | undefined => {
    const mapped = idMap.get(ref) ?? ref;
    let n = d.nodes.find((x) => x.id === mapped);
    if (!n && opts.lenient) {
      const s = slug(ref);
      n = d.nodes.find((x) => x.id === s) ?? d.nodes.find((x) => slug(x.label) === s);
    }
    return n;
  };
  const findEdge = (ref: string) => {
    const e = d.edges.find((x) => x.id === ref);
    if (e || !opts.lenient) return e;
    const m = ref.split(/\s*(?:->|→|>)\s*/);
    if (m.length === 2) {
      const a = findNode(m[0]!);
      const b = findNode(m[1]!);
      if (a && b) return d.edges.find((x) => x.source === a.id && x.target === b.id);
    }
    return undefined;
  };

  for (const op of ops) {
    switch (op.type) {
      case "add_node": {
        const nid = freshId(op.id ?? op.label);
        if (op.id) idMap.set(op.id, nid);
        const hasPos = op.x !== undefined && op.y !== undefined;
        d.nodes.push({
          id: nid,
          kind: op.kind,
          label: op.label,
          description: op.description || undefined,
          x: op.x ?? 0,
          y: op.y ?? 0,
          by,
        });
        if (!hasPos) unplaced.push(nid);
        addedNodeIds.push(nid);
        lines.push(`add ${KIND_LABEL[op.kind].toLowerCase()} ${q(op.label)}`);
        break;
      }
      case "update_node": {
        const n = findNode(op.id);
        if (!n) {
          errors.push(`update_node: no box called "${op.id}"`);
          break;
        }
        const old = n.label;
        if (op.label) n.label = op.label;
        if (op.kind) n.kind = op.kind;
        if (op.description !== undefined) n.description = op.description || undefined;
        lines.push(op.label && op.label !== old ? `rename ${q(old)} to ${q(op.label)}` : `update ${q(n.label)}`);
        break;
      }
      case "move_node": {
        const n = findNode(op.id);
        if (!n) {
          errors.push(`move_node: no box called "${op.id}"`);
          break;
        }
        n.x = Math.round(op.x);
        n.y = Math.round(op.y);
        const i = unplaced.indexOf(n.id);
        if (i >= 0) unplaced.splice(i, 1);
        lines.push(`move ${q(n.label)}`);
        break;
      }
      case "remove_node": {
        const n = findNode(op.id);
        if (!n) {
          errors.push(`remove_node: no box called "${op.id}"`);
          break;
        }
        d.nodes = d.nodes.filter((x) => x.id !== n.id);
        d.edges = d.edges.filter((e) => e.source !== n.id && e.target !== n.id);
        lines.push(`remove ${q(n.label)}`);
        break;
      }
      case "connect": {
        const a = findNode(op.source);
        const b = findNode(op.target);
        if (!a || !b) {
          errors.push(`connect: unknown box "${!a ? op.source : op.target}"`);
          break;
        }
        if (a.id === b.id) {
          errors.push(`connect: cannot connect ${q(a.label)} to itself`);
          break;
        }
        const existing = d.edges.find((e) => e.source === a.id && e.target === b.id);
        if (existing) {
          if (op.label !== undefined && op.label !== existing.label) {
            existing.label = op.label || undefined;
            lines.push(`label ${a.label} → ${b.label} ${q(op.label)}`);
          }
          break;
        }
        d.edges.push({
          id: freshId(op.id ?? `${a.id}-${b.id}`),
          source: a.id,
          target: b.id,
          label: op.label || undefined,
          by,
        });
        lines.push(`connect ${a.label} → ${b.label}`);
        break;
      }
      case "update_edge": {
        const e = findEdge(op.id);
        if (!e) {
          errors.push(`update_edge: no connection "${op.id}"`);
          break;
        }
        e.label = op.label || undefined;
        lines.push(`label connection ${q(op.label)}`);
        break;
      }
      case "disconnect": {
        const e = findEdge(op.id);
        if (!e) {
          errors.push(`disconnect: no connection "${op.id}"`);
          break;
        }
        d.edges = d.edges.filter((x) => x.id !== e.id);
        const a = d.nodes.find((n) => n.id === e.source);
        const b = d.nodes.find((n) => n.id === e.target);
        lines.push(`disconnect ${a?.label ?? "?"} → ${b?.label ?? "?"}`);
        break;
      }
    }
  }

  // A near-empty canvas gets a full layout; otherwise new boxes go next to their neighbours.
  if (unplaced.length) {
    if (placedBefore <= 1) {
      const pos = layeredLayout(d.nodes, d.edges);
      for (const n of d.nodes) {
        const p = pos.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
        }
      }
    } else {
      const waiting = new Set(unplaced);
      for (const nid of unplaced) {
        const placed = d.nodes.filter((n) => !waiting.has(n.id));
        const p = placeNear(nid, placed, d.edges);
        const n = d.nodes.find((x) => x.id === nid)!;
        n.x = p.x;
        n.y = p.y;
        waiting.delete(nid);
      }
    }
  }

  return { diagram: d, lines, errors, changed: lines.length > 0, addedNodeIds };
}

export function summarize(lines: string[]): string {
  if (!lines.length) return "no changes";
  const moves = lines.filter((l) => l.startsWith("move "));
  if (moves.length === lines.length) return moves.length === 1 ? lines[0]! : `moved ${moves.length} boxes`;
  if (lines.length === 1) return lines[0]!;
  return `${lines[0]} and ${lines.length - 1} more edit${lines.length > 2 ? "s" : ""}`;
}
