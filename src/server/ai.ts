import { KIND_LABEL, NODE_KINDS, OpSchema, type Diagram, type Op, type Severity } from "../shared/diagram";
import type { ChatMessage, Finding } from "../shared/protocol";
import { scanPartial } from "./json-stream";

export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
export const VOICE_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
// Aura-2 sounds far less clipped than Aura-1; "cora" is one of its calmer, warmer voices.
export const TTS_MODEL = "@cf/deepgram/aura-2-en";
export const TTS_SPEAKER = "cora";

type Msg = { role: "system" | "user" | "assistant"; content: string };

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

export function describeDiagram(d: Diagram, mark?: Set<string>): string {
  if (!d.nodes.length) return "The canvas is empty.";
  const nodes = d.nodes
    .map((n) => `- ${n.id} | ${n.kind} | ${n.label}${n.description ? ` | ${n.description}` : ""}${mark?.has(n.id) ? " | NEW" : ""}`)
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

async function runJson(ai: Ai, messages: Msg[], schema: object, maxTokens: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0
      ? messages
      : [...messages, { role: "user" as const, content: "Your last answer was not valid JSON. Reply again with ONLY the JSON object." }];
    const res = (await ai.run(CHAT_MODEL, {
      messages: msgs,
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: maxTokens,
      temperature: attempt === 0 ? 0.3 : 0,
    } as never)) as { response?: unknown };
    const parsed = parseJson(res?.response);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  }
  throw new Error("The model did not return valid JSON");
}

/** `onText` receives the full text so far, not the latest delta. */
async function streamJson(ai: Ai, messages: Msg[], schema: object, maxTokens: number, onText: (text: string) => void): Promise<string> {
  const out = (await ai.run(CHAT_MODEL, {
    messages,
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: true,
  } as never)) as unknown;
  // Usually a ReadableStream, but some paths hand back a Response or an already-finished result.
  const stream =
    out instanceof ReadableStream ? out
    : out instanceof Response ? out.body
    : typeof (out as { getReader?: unknown })?.getReader === "function" ? (out as ReadableStream<Uint8Array>)
    : null;
  if (!stream) {
    const r = (out as { response?: unknown })?.response;
    const text = typeof r === "string" ? r : r && typeof r === "object" ? JSON.stringify(r) : "";
    if (!text) throw new Error("Empty model response");
    onText(text);
    return text;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    let grew = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
        // Prefer `delta.content`: the legacy `response` field arrives as a JSON number for numeric tokens (e.g. 100).
        const delta = chunk.choices?.[0]?.delta?.content;
        const piece =
          typeof delta === "string" ? delta
          : typeof chunk.response === "string" ? chunk.response
          : typeof chunk.response === "number" ? String(chunk.response)
          : "";
        if (piece) {
          text += piece;
          grew = true;
        }
      } catch {
        /* partial or non-JSON line */
      }
    }
    if (grew) onText(text);
  }
  return text;
}

const EDIT_WORDS =
  /\b(add|adding|remove|delete|drop|design (a|an|me|it|for|this|something)|redesign|build|create|draw|sketch|connect|disconnect|wire|replace|rename|change|move|insert|split|merge|introduce|put|swap|include|attach|label|update|fix|make)\b/;

// Questions get an answer-only prompt with no way to edit; otherwise Llama tends to "help" by adding boxes.
export function wantsAnswerOnly(text: string): boolean {
  const t = text.toLowerCase().trim();
  const explain = /\b(explain|describe|walk (me )?through|summari[sz]e|tell me about|what (exactly )?(does|do|is|are)|what's)\b/.test(t);
  const alsoEdit = /\b(and|then|also) (add|remove|build|design|create|draw|connect|fix|change)\b/.test(t);
  if (explain && !alsoEdit) return true;
  const question = /\?\s*$/.test(t) || /^(what|why|how|is|are|does|do|which|where|when|who|should|would|could)\b/.test(t);
  return question && !EDIT_WORDS.test(t);
}

const OP_ITEM = {
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
};
const HIGHLIGHTS = {
  type: "array",
  items: {
    type: "object",
    properties: { id: { type: "string" }, severity: { type: "string", enum: ["critical", "warning", "ok"] } },
    required: ["id", "severity"],
  },
};
// Order matters: the model writes properties in this order, so edits stream in before the reply.
const DESIGN_SCHEMA = {
  type: "object",
  properties: { ops: { type: "array", items: OP_ITEM }, highlights: HIGHLIGHTS, reply: { type: "string" } },
  required: ["ops", "reply"],
};
const ANSWER_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" }, highlights: HIGHLIGHTS },
  required: ["reply"],
};

export type SelectedBox = { id: string; label: string };

function selectionNote(selection: SelectedBox[]): string {
  if (!selection.length) return "";
  return `\nThe user has these boxes selected on the canvas. Words like "this", "these", "it", "them" or "selected" refer to them:\n${selection.map((s) => `- ${s.id} | ${s.label}`).join("\n")}\n`;
}

function designSystemPrompt(diagram: Diagram, humanChanges: string[], selection: SelectedBox[]): string {
  const kinds = NODE_KINDS.map((k) => `${k} (${KIND_HELP[k]})`).join(", ");
  return `You are Drawboard AI, a senior systems architect pair-designing a software architecture diagram with a team on a shared canvas. People also edit the canvas directly.

Answer with ONLY a JSON object, in this order: {"ops": [...], "highlights": [...], "reply": string}.

How to edit the diagram (ops):
- {"type":"add_node","id":"redis-cache","kind":"cache","label":"Redis cache","description":"one-line note on its job"}
- {"type":"connect","source":"api","target":"redis-cache","label":"reads"}
- {"type":"update_node","id":"api","label":"New label"}  (also "kind" or "description")
- {"type":"remove_node","id":"old-box"}
- {"type":"disconnect","id":"api -> db"}
- {"type":"update_edge","id":"api -> db","label":"writes"}

Rules:
- Make the smallest set of edits that does what was asked. Never remove or rename boxes unless asked.
- If the canvas is empty and the user asks for a system, design it: 6 to 12 boxes. Add each box and then its connections right after, so the diagram grows in the direction requests and data flow. Every box must end up connected.
- Design like a senior engineer, not a generic web stack. Include the pieces that make THIS system work (for example WebSocket servers and a presence store for chat, an ID generator for a URL shortener, a matching service and location store for ride-sharing, a fan-out queue for feeds).
- Use concrete technology names in labels where it helps ("Postgres", "Redis cache", "Kafka", "S3 media"), and give every new box a one-line description of its job.
- New box ids are short lowercase slugs. Refer to existing boxes by their exact id from the list below.
- "kind" must be one of: ${kinds}.
- Labels: 1 to 3 words, max 24 characters. Connection labels: 1 or 2 words, max 16 characters, or omit.
- Never include positions. Layout is automatic.
- If the diagram already has what was asked for, don't add it again; say so instead.
- highlights: boxes you want the team to look at (critical = at risk, warning = concern, ok = fine). Often empty.
- reply: 1 to 4 short sentences in plain language. Be concrete: name tradeoffs and rough numbers. Your ops are applied the moment you write them, so describe them in the past tense ("Added a Redis cache in front of Postgres…"). Never promise to do something later. If people changed the diagram since your last reply, acknowledge it briefly when it matters.
- Text in [square brackets] in earlier messages is a system note about what really happened. Trust it, and never write such notes yourself.
${selectionNote(selection)}
Current diagram:
${describeDiagram(diagram)}

${humanChanges.length ? `Changes people made since your last reply:\n${humanChanges.map((c) => `- ${c}`).join("\n")}` : "No one has changed the diagram since your last reply."}`;
}

function answerSystemPrompt(diagram: Diagram, selection: SelectedBox[]): string {
  return `You are Drawboard AI, a senior systems architect helping a team understand the architecture diagram on their shared canvas.

Answer the question. You cannot change the diagram in this reply. If a change would help, suggest it in words and say they can ask you to make it.

Answer with ONLY a JSON object: {"reply": string, "highlights": [{"id": "<box id>", "severity": "critical" | "warning" | "ok"}]}.

How to answer:
- Base the answer on the current diagram below and refer to boxes by their labels.
- If asked what the components do, go through EVERY box (or every selected box), one per line, as "• <label>: <what it does in this design and why it is there>".
- For "what if" questions, explain the impact step by step and name the fix. Highlight the affected boxes (critical = breaks, warning = degraded, ok = keeps working).
- Plain, concrete language. Short paragraphs or "• " bullet lines. Stay under about 200 words unless you are listing every box.
- If the canvas is empty, say so and offer to design something.
- Text in [square brackets] in earlier messages is a system note about what really happened. Trust it, and never write such notes yourself.
${selectionNote(selection)}
Current diagram:
${describeDiagram(diagram)}`;
}

export interface TurnArgs {
  diagram: Diagram;
  chat: ChatMessage[];
  humanChanges: string[];
  userName: string;
  text: string;
  selection: SelectedBox[];
}

export interface TurnHandlers {
  onOp: (op: Op) => void;
  onReply: (text: string) => void;
}

export interface TurnResult {
  mode: "edit" | "answer";
  reply: string;
  highlights: Record<string, Severity>;
  rejected: string[];
}

function historyMessages(chat: ChatMessage[]): Msg[] {
  // Annotate past AI replies with what they actually did, or the model talks itself into thinking nothing was built.
  return chat
    .filter((m) => m.role !== "system" && m.status !== "thinking" && m.text)
    .slice(-8)
    .map((m) => {
      if (m.role !== "ai") return { role: "user" as const, content: `${m.author.name}: ${m.text}` };
      const note = m.findings
        ? "[This was a design review; it pinned notes to boxes]"
        : m.ops?.length
          ? `[Edits applied to the diagram: ${m.ops.slice(0, 25).join("; ")}${m.ops.length > 25 ? `; and ${m.ops.length - 25} more` : ""}]`
          : "[No diagram edits were made in this reply]";
      return { role: "assistant" as const, content: `${m.text}\n${note}` };
    });
}

export async function runChatTurn(ai: Ai, args: TurnArgs, h: TurnHandlers): Promise<TurnResult> {
  const mode = wantsAnswerOnly(args.text) ? "answer" : "edit";
  const n = args.diagram.nodes.length;
  const reminder = n
    ? `[The canvas currently has ${n} boxes: ${args.diagram.nodes.slice(0, 30).map((x) => x.label).join(", ")}]`
    : "[The canvas is currently empty]";
  const selected = args.selection.length ? `\n[Selected: ${args.selection.map((s) => s.label).join(", ")}]` : "";
  const messages: Msg[] = [
    { role: "system", content: mode === "answer" ? answerSystemPrompt(args.diagram, args.selection) : designSystemPrompt(args.diagram, args.humanChanges, args.selection) },
    ...historyMessages(args.chat),
    { role: "user", content: `${args.userName}: ${args.text}\n\n${reminder}${selected}` },
  ];
  const schema = mode === "answer" ? ANSWER_SCHEMA : DESIGN_SCHEMA;
  const maxTokens = mode === "answer" ? 1600 : 2400;

  const rejected: string[] = [];
  let emitted = 0;
  const emitRaw = (raw: unknown) => {
    const r = OpSchema.safeParse(normalizeOp(raw));
    if (r.success) h.onOp(r.data);
    else rejected.push(JSON.stringify(raw).slice(0, 120));
  };

  let final: Record<string, unknown> | null = null;
  try {
    const text = await streamJson(ai, messages, schema, maxTokens, (buf) => {
      const s = scanPartial(buf);
      while (mode === "edit" && emitted < s.ops.length) {
        const raw = s.ops[emitted++]!;
        try {
          emitRaw(JSON.parse(raw));
        } catch {
          rejected.push(raw.slice(0, 120));
        }
      }
      if (s.reply !== null) h.onReply(s.reply);
    });
    final = parseJson(text) as Record<string, unknown> | null;
    // Catch ops the scanner missed, e.g. ones written after the reply.
    if (final && mode === "edit" && Array.isArray(final.ops)) for (const raw of final.ops.slice(emitted)) emitRaw(raw);
  } catch (err) {
    console.warn("streaming failed, falling back", err);
  }

  if (!final && emitted === 0) {
    final = await runJson(ai, messages, schema, maxTokens);
    if (mode === "edit" && Array.isArray(final.ops)) {
      for (const raw of final.ops.slice(0, 60)) {
        emitRaw(raw);
        await new Promise((r) => setTimeout(r, 140));
      }
    }
  }

  const replyText = typeof final?.reply === "string" ? final.reply.trim() : "";
  const reply = replyText || (mode === "answer" ? "Sorry, I couldn't put an answer together. Try asking again." : "Done.");
  h.onReply(reply);
  return { mode, reply, highlights: parseHighlights(final?.highlights), rejected };
}

const CHECK_SCHEMA = {
  type: "object",
  properties: { fixes: { type: "array", items: OP_ITEM }, note: { type: "string" } },
  required: ["fixes", "note"],
};

export async function verifyDesign(ai: Ai, request: string, diagram: Diagram, added: Set<string>): Promise<{ fixes: Op[]; note: string }> {
  const kinds = NODE_KINDS.join(", ");
  const raw = await runJson(
    ai,
    [
      {
        role: "system",
        content: `You are a strict reviewer checking an architecture diagram an AI just drew. Boxes marked NEW were added in response to the request.
Check:
1. Every NEW box is connected to something, and arrows point the way requests and data flow.
2. No two boxes do the same job (duplicates). Remove only NEW duplicates.
3. Nothing essential for the request is missing. Add at most 2 boxes, and connect them.
Return ONLY JSON: {"fixes": [ops], "note": "<one short sentence on what you fixed, or 'Looks good'>"}.
Ops use the same format: {"type":"connect","source":"<id>","target":"<id>"}, {"type":"add_node","id":"<slug>","kind":"<kind>","label":"<label>","description":"<job>"}, {"type":"remove_node","id":"<NEW id>"}, {"type":"disconnect","id":"<source> -> <target>"}.
kind must be one of: ${kinds}. Use exact ids. If the diagram is fine, return {"fixes": [], "note": "Looks good"}.`,
      },
      { role: "user", content: `Request: ${request}\n\n${describeDiagram(diagram, added)}` },
    ],
    CHECK_SCHEMA,
    1000,
  );
  const fixes: Op[] = [];
  for (const item of Array.isArray(raw.fixes) ? raw.fixes.slice(0, 10) : []) {
    const r = OpSchema.safeParse(normalizeOp(item));
    if (!r.success) continue;
    // Only boxes added this turn may be removed; never delete what people made.
    if (r.data.type === "remove_node" && !added.has(r.data.id)) continue;
    fixes.push(r.data);
  }
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 200) : "";
  return { fixes, note };
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

export async function connectIsolated(ai: Ai, diagram: Diagram, isolated: string[]): Promise<Op[]> {
  const raw = await runJson(
    ai,
    [
      {
        role: "system",
        content: `You connect boxes in a software architecture diagram. Some boxes have no connections yet. Return ONLY JSON: {"connections":[{"source":"<box id>","target":"<box id>","label":"<1-2 words, optional>"}]}.
Connect each unconnected box the way requests and data actually flow (client -> edge/gateway -> services -> stores/queues -> workers). Use the exact ids from the list.`,
      },
      { role: "user", content: `${describeDiagram(diagram)}\n\nUnconnected boxes: ${isolated.join(", ")}` },
    ],
    CONNECT_SCHEMA,
    900,
  );
  const out: Op[] = [];
  for (const c of Array.isArray(raw.connections) ? raw.connections.slice(0, 30) : []) {
    const r = OpSchema.safeParse(normalizeOp({ type: "connect", ...(c as object) }));
    if (r.success) out.push(r.data);
  }
  return out;
}

function parseHighlights(list: unknown): Record<string, Severity> {
  const out: Record<string, Severity> = {};
  for (const h of Array.isArray(list) ? list : []) {
    const id = (h as { id?: unknown }).id;
    const sev = (h as { severity?: unknown }).severity;
    if (typeof id === "string" && (sev === "critical" || sev === "warning" || sev === "ok")) out[id] = sev;
  }
  return out;
}

function normalizeOp(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const o = { ...(item as Record<string, unknown>) };
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === "") delete o[k];
  // Synonyms the model sometimes uses.
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
  const raw = await runJson(
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
  );

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

const TOUR_SCHEMA = {
  type: "object",
  properties: {
    intro: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, what: { type: "string" }, why: { type: "string" } },
        required: ["id", "what", "why"],
      },
    },
    outro: { type: "string" },
  },
  required: ["intro", "steps", "outro"],
};

export interface TourHandlers {
  onIntro: (text: string) => void;
  onStep: (id: string, what: string, why: string) => void;
}

/** Writes a beginner-friendly explanation for each box, in the given order. Returns the closing line. */
export async function writeTour(ai: Ai, diagram: Diagram, order: string[], h: TourHandlers): Promise<string> {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const stops = order.map((id) => byId.get(id)!).filter(Boolean);
  const messages: Msg[] = [
    {
      role: "system",
      content: `You are a friendly teacher giving a guided tour of a software architecture diagram to someone who is new to system design. Assume they know what a website and a server are, and nothing more.

Return ONLY JSON: {"intro": string, "steps": [{"id": "<box id>", "what": string, "why": string}], "outro": string}.

- intro: 2 short sentences (under 45 words). What the system does for the people using it, then the main path a request takes, by box label.
- steps: one per box, in EXACTLY the order given, using the exact ids.
  - what: 2 short sentences (25 to 45 words). What THIS box does, judged by its label and notes, in plain words. If it uses a known technology (Redis, Kafka, Postgres, S3), say in a few words what that is. End with an everyday analogy when it helps.
  - why: 2 short sentences (25 to 45 words). Why this design needs it: the problem it solves here and what would go wrong without it. Don't just list what it connects to; the reader can see the arrows.
- outro: 2 short sentences (under 40 words). Sum up the journey in one line, then suggest one specific "what if" question to ask the AI next.
- Warm, simple, concrete. Short sentences: never join two sentences with a comma. No markdown, no bullet characters.

Example steps:
{"id":"matching","what":"The Matching Service pairs each ride request with a nearby free driver. It's the matchmaker of the app, a bit like a taxi dispatcher with a live map.","why":"Matching has to happen in seconds while thousands of drivers move around. Keeping it in its own service means it can scale up at rush hour without slowing payments or sign-ups."}
{"id":"redis","what":"Redis is an in-memory store, which means it keeps data in RAM and answers in under a millisecond. Here it acts as a cache: a quick-access copy of popular data, like keeping your keys by the door.","why":"Most visits ask for the same popular links. Checking Redis first keeps pages fast and stops Postgres from being flooded with the same reads."}`,
    },
    {
      role: "user",
      content: `${describeDiagram(diagram)}\n\nTour order (ids): ${stops.map((n) => n.id).join(", ")}`,
    },
  ];
  const maxTokens = Math.min(4000, 300 + stops.length * 150);
  let emitted = 0;
  let introSent = false;
  const emit = (raw: unknown) => {
    const x = raw as { id?: unknown; what?: unknown; why?: unknown };
    if (typeof x?.id === "string" && typeof x.what === "string" && typeof x.why === "string")
      h.onStep(x.id, x.what.trim().slice(0, 600), x.why.trim().slice(0, 600));
  };
  const text = await streamJson(ai, messages, TOUR_SCHEMA, maxTokens, (buf) => {
    const s = scanPartial(buf, "steps", "intro");
    if (!introSent && s.replyDone && s.reply) {
      introSent = true;
      h.onIntro(s.reply.trim());
    }
    while (emitted < s.ops.length) {
      try {
        emit(JSON.parse(s.ops[emitted]!));
      } catch {
        /* malformed item; the box gets fallback text */
      }
      emitted++;
    }
  });
  const final = parseJson(text) as { intro?: unknown; steps?: unknown; outro?: unknown } | null;
  if (!introSent && typeof final?.intro === "string") h.onIntro(final.intro.trim());
  if (Array.isArray(final?.steps)) for (const raw of final.steps.slice(emitted)) emit(raw);
  return typeof final?.outro === "string" ? final.outro.trim() : "";
}

export async function transcribe(ai: Ai, audio: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(audio);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = (await ai.run(VOICE_MODEL, { audio: btoa(bin) } as never)) as { text?: string };
  return (res?.text ?? "").trim();
}

export { KIND_LABEL };
