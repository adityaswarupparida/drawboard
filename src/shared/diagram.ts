import { z } from "zod";

/** Every box on the canvas has one of these kinds. The AI must pick from this list. */
export const NODE_KINDS = [
  "client",
  "cdn",
  "lb",
  "gateway",
  "service",
  "socket",
  "auth",
  "db",
  "cache",
  "queue",
  "worker",
  "storage",
  "search",
  "limiter",
  "push",
  "external",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const KIND_LABEL: Record<NodeKind, string> = {
  client: "Client",
  cdn: "Edge / CDN",
  lb: "Load balancer",
  gateway: "API gateway",
  service: "Service",
  socket: "WebSocket",
  auth: "Auth",
  db: "Database",
  cache: "Cache",
  queue: "Queue",
  worker: "Worker",
  storage: "Object storage",
  search: "Search",
  limiter: "Rate limiter",
  push: "Notifications",
  external: "External API",
};

export interface AuthorRef {
  id: string;
  name: string;
  ai?: boolean;
}

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  x: number;
  y: number;
  by: AuthorRef;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  by: AuthorRef;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type Severity = "critical" | "warning" | "tip" | "ok";

export interface Annotation {
  nodeId: string;
  severity: Severity;
  title: string;
  detail: string;
}

export const NODE_W = 184;
export const NODE_H = 64;

/* ------------------------------------------------------------------ */
/* Edits ("ops"). Humans and the AI change the diagram ONLY through    */
/* these. The server validates every op before applying it.            */
/* ------------------------------------------------------------------ */

const id = z.string().trim().min(1).max(48);
const label = z.string().trim().min(1).max(40);
const coord = z.number().finite().min(-100_000).max(100_000);

export const OpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_node"),
    id: id.optional(),
    kind: z.enum(NODE_KINDS),
    label,
    description: z.string().trim().max(280).optional(),
    x: coord.optional(),
    y: coord.optional(),
  }),
  z.object({
    type: z.literal("update_node"),
    id,
    label: label.optional(),
    kind: z.enum(NODE_KINDS).optional(),
    description: z.string().trim().max(280).optional(),
  }),
  z.object({ type: z.literal("move_node"), id, x: coord, y: coord }),
  z.object({ type: z.literal("remove_node"), id }),
  z.object({
    type: z.literal("connect"),
    id: id.optional(),
    source: id,
    target: id,
    label: z.string().trim().max(24).optional(),
  }),
  z.object({ type: z.literal("update_edge"), id, label: z.string().trim().max(24) }),
  z.object({ type: z.literal("disconnect"), id }),
]);
export type Op = z.infer<typeof OpSchema>;
export const OpListSchema = z.array(OpSchema).max(80);

export function emptyDiagram(): Diagram {
  return { nodes: [], edges: [] };
}
