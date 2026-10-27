import type { Diagram, NodeKind } from "../shared/diagram";

// Tie-breaker when several boxes could come next: edge first, then logic, then storage and async work.
const RANK: NodeKind[] = ["client", "cdn", "limiter", "lb", "gateway", "auth", "socket", "service", "cache", "search", "db", "queue", "worker", "storage", "push", "external"];

/**
 * Orders boxes the way a request travels: start where nothing points in, then go
 * layer by layer along the arrows. That matches the left-to-right auto layout, so
 * the camera mostly moves one way. Cycles and loose boxes go last.
 */
export function tourOrder(d: Diagram): string[] {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const e of d.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }
  const cmp = (a: string, b: string) => {
    const x = byId.get(a)!;
    const y = byId.get(b)!;
    return RANK.indexOf(x.kind) - RANK.indexOf(y.kind) || x.y - y.y || x.x - y.x;
  };
  const ids = [...byId.keys()].sort(cmp);
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (roots: string[]) => {
    let layer = roots.filter((id) => !seen.has(id));
    layer.forEach((id) => seen.add(id));
    while (layer.length) {
      order.push(...layer);
      const next: string[] = [];
      for (const id of layer)
        for (const t of out.get(id) ?? [])
          if (!seen.has(t)) {
            seen.add(t);
            next.push(t);
          }
      layer = next.sort(cmp);
    }
  };
  walk(ids.filter((id) => !incoming.get(id)));
  for (const id of ids) walk([id]);
  return order;
}

/** Changes only when what the tour talks about changes; moving boxes keeps the cached tour. */
export function tourKey(d: Diagram): string {
  const nodes = d.nodes.map((n) => `${n.id}|${n.kind}|${n.label}|${n.description ?? ""}`).sort();
  const edges = d.edges.map((e) => `${e.source}>${e.target}|${e.label ?? ""}`).sort();
  let h = 0x811c9dc5;
  for (const ch of `${nodes.join("\n")}\n--\n${edges.join("\n")}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${d.nodes.length}-${h.toString(36)}`;
}

/** Used when the model skips a box or the call fails. */
export const KIND_EXPLAIN: Record<NodeKind, string> = {
  client: "The people and apps using the system, like a web browser or a phone app.",
  cdn: "A network of servers around the world that keeps copies of files close to users, so things load faster.",
  lb: "Spreads incoming traffic across several copies of a service, so no single server gets overloaded.",
  gateway: "The front door of the backend: it receives every request, checks it, and sends it to the right service.",
  service: "A program that runs the logic for one part of the product.",
  socket: "Keeps a live, two-way connection open with each user, so updates arrive instantly without refreshing.",
  auth: "Checks who someone is when they sign in and what they're allowed to do.",
  db: "Stores the system's data permanently, so nothing is lost when servers restart.",
  cache: "A very fast short-term memory for data that's read often, so the database isn't asked every time.",
  queue: "A waiting line for work: one part drops off a job, and another picks it up when it's ready.",
  worker: "A background program that does slow jobs from a queue, so users don't have to wait for them.",
  storage: "Cheap storage for big files like images, videos and backups.",
  search: "An index built for fast text search and filtering.",
  limiter: "Caps how many requests each user can make, protecting the system from abuse and overload.",
  push: "Sends notifications to people by push, email or text.",
  external: "A service run by another company that this system relies on.",
};

export function fallbackWhy(d: Diagram, id: string): string {
  const n = d.nodes.find((x) => x.id === id);
  if (n?.description) return n.description;
  const label = (x: string) => d.nodes.find((m) => m.id === x)?.label;
  const from = d.edges.filter((e) => e.target === id).map((e) => label(e.source)).filter(Boolean);
  const to = d.edges.filter((e) => e.source === id).map((e) => label(e.target)).filter(Boolean);
  if (from.length && to.length) return `It sits between ${from.join(", ")} and ${to.join(", ")}.`;
  if (to.length) return `It sends work on to ${to.join(", ")}.`;
  if (from.length) return `${from.join(", ")} rel${from.length > 1 ? "y" : "ies"} on it.`;
  return "It isn't connected to anything yet.";
}
