import { KIND_LABEL, NODE_KINDS, OpSchema, type Diagram, type Op, type Severity } from "../shared/diagram";
import type { ChatMessage, Finding } from "../shared/protocol";

export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
export const VOICE_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;

const KIND_HELP: Record<string, string> = {
  client: "browsers, mobile apps, users",
  cdn: "CDN / edge cache",
  lb: "load balancer",
  gateway: "API gateway / ingress",
  service: "application service or API",
  socket: "WebSocket / realtime servers",
  auth: "authentication / identity",
  db: "database (SQL or NoSQL)",
  cache: "in-memory cache like Redis",
  queue: "message queue / stream like Kafka",
  worker: "background worker / consumer",
  storage: "object/blob storage like S3 or R2",
  search: "search index like Elasticsearch",
  limiter: "rate limiter",
  push: "notifications (push, email, SMS)",
  external: "third-party API",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

export function describeDiagram(d: Diagram): string {
  if (!d.nodes.length) return "The canvas is empty.";
  const nodes = d.nodes
    .map((n) => `- ${n.id} | ${n.kind} | ${n.label}${n.description ? ` | ${n.description}` : ""}`)
    .join("\n");
  const edges = d.edges.length
    ? d.edges.map((e) => `- ${e.source} -> ${e.target}${e.label ? ` (${e.label})` : ""}`).join("\n")
    : "(none)";
  return `Boxes (id | kind | label | notes):\n${nodes}\n\nConnections (source -> target):\n${edges}`;
}

function parseJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runJson(
  ai: Ai,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  schema: object,
  maxTokens: number,
): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0
      ? messages
      : [
          ...messages,
          { role: "user" as const, content: `Your last answer was not valid JSON (${lastError}). Reply again with ONLY the JSON object.` },
        ];
    const res = (await ai.run(CHAT_MODEL, {
      messages: msgs,
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: maxTokens,
      temperature: attempt === 0 ? 0.3 : 0,
    } as never)) as { response?: unknown };
    const parsed = parseJson(res?.response);
    if (parsed && typeof parsed === "object") return parsed;
    lastError = "could not parse";
  }
  throw new Error("The model did not return valid JSON");
}

/* ------------------------------------------------------------------ */
/* Design chat                                                        */
/* ------------------------------------------------------------------ */

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["add_node", "update_node", "remove_node", "connect", "disconnect", "update_edge"] },
          id: { type: "string" },
          kind: { type: "string", enum: [...NODE_KINDS] },
          label: { type: "string" },
          description: { type: "string" },
          source: { type: "string" },
          target: { type: "string" },
        },
        required: ["type"],
      },
    },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["critical", "warning", "ok"] },
        },
        required: ["id", "severity"],
      },
    },
  },
  required: ["reply", "ops"],
};

function designSystemPrompt(diagram: Diagram, humanChanges: string[]): string {
  const kinds = NODE_KINDS.map((k) => `${k} (${KIND_HELP[k]})`).join(", ");
  return `You are Drawboard AI, a senior systems architect pair-designing a software architecture diagram with a team on a shared canvas. People also edit the canvas directly.

Answer with ONLY a JSON object: {"reply": string, "ops": [...], "highlights": [...]}.

How to edit the diagram (ops):
- {"type":"add_node","id":"redis-cache","kind":"cache","label":"Redis cache","description":"optional one-line note"}
- {"type":"connect","source":"api","target":"redis-cache","label":"reads"}
- {"type":"update_node","id":"api","label":"New label"}  (also "kind" or "description")
- {"type":"remove_node","id":"old-box"}
- {"type":"disconnect","id":"api -> db"}
- {"type":"update_edge","id":"api -> db","label":"writes"}

Rules:
- Make the smallest set of edits that does what was asked. Never remove or rename boxes unless asked.
- If the user asks a question ("what if", "why", "how", "is this ok"), answer it in reply. Usually make no ops. Put the boxes you talk about in highlights (critical = breaks or is at risk, warning = concern, ok = fine).
- If the canvas is empty and the user asks for a system, design it: 6 to 12 boxes. After the add_node ops, ALWAYS add connect ops so every box is connected, in the direction requests and data flow.
- Design like a senior engineer, not a generic web stack. Include the pieces that make THIS system work (for example WebSocket servers and a presence store for chat, an ID generator for a URL shortener, a matching service and location store for ride-sharing, a fan-out queue for feeds).
- Use concrete technology names in labels where it helps ("Postgres", "Redis cache", "Kafka", "S3 media"), and give every new box a one-line description of its job.
- New box ids are short lowercase slugs. Refer to existing boxes by their exact id from the list below.
- "kind" must be one of: ${kinds}.
- Labels: 1 to 3 words, max 24 characters. Connection labels: 1 or 2 words, max 16 characters, or omit.
- Never include positions. Layout is automatic.
- reply: 1 to 4 short sentences in plain language. Be concrete: name tradeoffs and rough numbers. Say what you changed. If people changed the diagram since your last reply, acknowledge it briefly when it matters.

Current diagram:
${describeDiagram(diagram)}

${humanChanges.length ? `Changes people made since your last reply:\n${humanChanges.map((c) => `- ${c}`).join("\n")}` : "No one has changed the diagram since your last reply."}`;
}

export interface DesignResult {
  reply: string;
  ops: Op[];
  rejected: string[];
  highlights: Record<string, Severity>;
}

export async function runDesignTurn(
  ai: Ai,
  args: { diagram: Diagram; chat: ChatMessage[]; humanChanges: string[]; userName: string; text: string },
): Promise<DesignResult> {
  const history = args.chat
    .filter((m) => m.role !== "system" && m.status !== "thinking" && m.text)
    .slice(-8)
    .map((m) =>
      m.role === "ai"
        ? { role: "assistant" as const, content: m.text }
        : { role: "user" as const, content: `${m.author.name}: ${m.text}` },
    );
  const messages = [
    { role: "system" as const, content: designSystemPrompt(args.diagram, args.humanChanges) },
    ...history,
    { role: "user" as const, content: `${args.userName}: ${args.text}` },
  ];
  const raw = (await runJson(ai, messages, DESIGN_SCHEMA, 2048)) as {
    reply?: unknown;
    ops?: unknown;
    highlights?: unknown;
  };

  const ops: Op[] = [];
  const rejected: string[] = [];
  for (const item of Array.isArray(raw.ops) ? raw.ops.slice(0, 60) : []) {
    const r = OpSchema.safeParse(normalizeOp(item));
    if (r.success) ops.push(r.data);
    else rejected.push(JSON.stringify(item).slice(0, 120));
  }
  const highlights: Record<string, Severity> = {};
  for (const h of Array.isArray(raw.highlights) ? raw.highlights : []) {
    const id = (h as { id?: unknown }).id;
    const sev = (h as { severity?: unknown }).severity;
    if (typeof id === "string" && (sev === "critical" || sev === "warning" || sev === "ok")) highlights[id] = sev;
  }
  // Llama sometimes adds a batch of boxes and forgets to wire them up. Ask once more for just the connections.
  const added = ops.filter((o) => o.type === "add_node");
  const connects = ops.filter((o) => o.type === "connect").length;
  if (added.length >= 3 && connects < added.length - 1) {
    try {
      ops.push(...(await askForConnections(ai, args.diagram, added)));
    } catch (e) {
      console.warn("follow-up for connections failed", e);
    }
  }

  const reply = typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : ops.length ? "Done." : "I'm not sure how to help with that. Try describing a change to the diagram.";
  return { reply, ops, rejected, highlights };
}

const CONNECT_SCHEMA = {
  type: "object",
  properties: {
    connections: {
      type: "array",
      items: {
        type: "object",
        properties: { source: { type: "string" }, target: { type: "string" }, label: { type: "string" } },
        required: ["source", "target"],
      },
    },
  },
  required: ["connections"],
};

async function askForConnections(ai: Ai, diagram: Diagram, added: Extract<Op, { type: "add_node" }>[]): Promise<Op[]> {
  const boxes = [
    ...diagram.nodes.map((n) => `- ${n.id} | ${n.kind} | ${n.label}`),
    ...added.map((n) => `- ${n.id ?? n.label} | ${n.kind} | ${n.label}${n.description ? ` | ${n.description}` : ""}`),
  ].join("\n");
  const raw = (await runJson(
    ai,
    [
      {
        role: "system",
        content: `You connect boxes in a software architecture diagram. Return ONLY JSON: {"connections":[{"source":"<box id>","target":"<box id>","label":"<1-2 words, optional>"}]}.
Connect them the way requests and data actually flow (client -> edge/gateway -> services -> stores/queues -> workers). Every box should have at least one connection. Use the exact ids from the list.`,
      },
      { role: "user", content: `Boxes (id | kind | label | notes):\n${boxes}` },
    ],
    CONNECT_SCHEMA,
    1200,
  )) as { connections?: unknown };
  const out: Op[] = [];
  for (const c of Array.isArray(raw.connections) ? raw.connections.slice(0, 40) : []) {
    const r = OpSchema.safeParse(normalizeOp({ type: "connect", ...(c as object) }));
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Small fixes for common model slips before strict validation. */
function normalizeOp(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const o = { ...(item as Record<string, unknown>) };
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === "") delete o[k];
  // Accept common synonyms the model sometimes uses.
  if (o.source === undefined && typeof o.from === "string") o.source = o.from;
  if (o.target === undefined && typeof o.to === "string") o.target = o.to;
  if (o.label === undefined && typeof o.name === "string") o.label = o.name;
  if (typeof o.label === "string") o.label = o.label.slice(0, o.type === "connect" || o.type === "update_edge" ? 24 : 40);
  if (typeof o.description === "string") o.description = o.description.slice(0, 280);
  if (typeof o.kind === "string") {
    const k = o.kind.toLowerCase();
    o.kind = (NODE_KINDS as readonly string[]).includes(k) ? k : guessKind(k);
  }
  if (o.type === "update_edge" && o.label === undefined) o.label = "";
  return o;
}

function guessKind(k: string): string {
  if (/data|sql|postgres|mysql|mongo|dynamo|cassandra/.test(k)) return "db";
  if (/redis|memcache/.test(k)) return "cache";
  if (/kafka|stream|pubsub|sqs/.test(k)) return "queue";
  if (/s3|blob|bucket|r2/.test(k)) return "storage";
  if (/user|browser|mobile|app/.test(k)) return "client";
  if (/balanc/.test(k)) return "lb";
  return "service";
}

/* ------------------------------------------------------------------ */
/* Design review (one call per area, run as Workflow steps)           */
/* ------------------------------------------------------------------ */

const AREA_FOCUS: Record<string, string> = {
  Reliability: "single points of failure, missing replicas/failover, retries, data loss risk",
  Scaling: "bottlenecks under 10x traffic, missing caches, hot partitions, synchronous work that should be async",
  Security: "missing auth, rate limiting, public exposure of internal services, secrets, abuse vectors",
  Cost: "expensive choices, over-provisioning, egress, cheaper alternatives such as caching at the edge",
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          severity: { type: "string", enum: ["critical", "warning", "tip"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["nodeId", "severity", "title", "detail"],
      },
    },
  },
  required: ["findings"],
};

export async function reviewArea(ai: Ai, diagram: Diagram, area: string): Promise<Finding[]> {
  if (!diagram.nodes.length) return [];
  const raw = (await runJson(
    ai,
    [
      {
        role: "system",
        content: `You review software architecture diagrams. Focus only on ${area.toUpperCase()}: ${AREA_FOCUS[area] ?? area}.
Return ONLY JSON: {"findings":[{"nodeId": "<exact box id>", "severity": "critical"|"warning"|"tip", "title": "<max 32 chars>", "detail": "<one or two sentences: the problem and the fix>"}]}.
Give at most 3 findings, the most important first. Only report real issues visible in this diagram. Use "critical" only for things that would cause outages or data loss. Return an empty list if nothing matters.`,
      },
      { role: "user", content: describeDiagram(diagram) },
    ],
    REVIEW_SCHEMA,
    900,
  )) as { findings?: unknown };

  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const out: Finding[] = [];
  for (const f of Array.isArray(raw.findings) ? raw.findings.slice(0, 3) : []) {
    const x = f as Record<string, unknown>;
    const node = typeof x.nodeId === "string" ? byId.get(x.nodeId) ?? diagram.nodes.find((n) => n.label.toLowerCase() === String(x.nodeId).toLowerCase()) : undefined;
    const sev = x.severity;
    if (!node || (sev !== "critical" && sev !== "warning" && sev !== "tip")) continue;
    out.push({
      nodeId: node.id,
      nodeLabel: node.label,
      severity: sev,
      title: String(x.title ?? "").slice(0, 40) || area,
      detail: String(x.detail ?? "").slice(0, 300),
      area,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Voice                                                              */
/* ------------------------------------------------------------------ */

export async function transcribe(ai: Ai, audio: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(audio);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = (await ai.run(VOICE_MODEL, { audio: btoa(bin) } as never)) as { text?: string };
  return (res?.text ?? "").trim();
}

export { KIND_LABEL };
