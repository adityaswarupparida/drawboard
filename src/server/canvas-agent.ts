import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { WorkersAIFluxSTT, WorkersAITTS, withVoice, type VoiceTurnContext } from "agents/voice";
import { nanoid } from "nanoid";
import { applyOps, slug, summarize } from "../shared/apply";
import { emptyDiagram, OpListSchema, type AuthorRef, type Diagram, type Op, type Severity } from "../shared/diagram";
import { layeredLayout } from "../shared/layout";
import {
  AI_AUTHOR,
  REVIEW_STEPS,
  canEdit,
  colorFor,
  type CanvasState,
  type ChatMessage,
  type ClientMessage,
  type Finding,
  type HistoryEntry,
  type Presence,
  type Role,
  type ServerMessage,
} from "../shared/protocol";
import { connectIsolated, runChatTurn, verifyDesign, wantsAnswerOnly } from "./ai";
import type { Env } from "./env";

// `voice` marks the second socket a browser opens for a live voice call.
type ConnState = { userId: string; name: string; role: Role; color: string; voice?: boolean };

const MAX_CHAT = 200;
const MAX_HISTORY = 300;
const MAX_SNAPSHOTS = 50;
const AI_STEP_MS = 170;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = () => nanoid(8);

const isVoiceRequest = (req: Request) => new URL(req.url).searchParams.get("voice") === "1";

// The voice mixin is marked experimental upstream, so `agents` is pinned to an exact version.
const VoiceAgent = withVoice(Agent);

export class CanvasAgent extends VoiceAgent<Env, CanvasState> {
  // Flux does its own turn detection; keyterms help it spell architecture jargon.
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    keyterms: ["Postgres", "Redis", "Kafka", "CDN", "load balancer", "API gateway", "WebSocket", "Cassandra", "S3", "R2", "D1"],
  });
  tts = new WorkersAITTS(this.env.AI, { speaker: "asteria" });

  initialState: CanvasState = {
    diagram: emptyDiagram(),
    annotations: [],
    highlights: {},
    review: { status: "idle" },
    aiBusy: null,
    version: 0,
    undo: null,
  };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, by_name TEXT NOT NULL, diagram TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS pending_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`;
    // A restart mid AI turn would otherwise leave the "AI is working" flag stuck.
    if (this.state.aiBusy) this.setState({ ...this.state, aiBusy: null });
  }

  // Clients never write state directly; edits must arrive as validated ops.
  validateStateChange(_next: CanvasState, source: Connection | "server") {
    if (source !== "server") throw new Error("Edits must be sent as ops");
  }

  // Overridden as prototype methods (not arrow fields) so the voice mixin's wrappers still run.
  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const userId = h.get("x-user-id");
    const role = h.get("x-role") as Role | null;
    if (!userId || !role) {
      conn.close(4401, "Not authorized");
      return;
    }
    const name = decodeURIComponent(h.get("x-user-name") ?? "Someone");
    const voice = isVoiceRequest(ctx.request);
    conn.setState({ userId, name, role, color: colorFor(userId), voice });
    if (voice) return;
    this.sendTo(conn, {
      type: "hello",
      you: this.presenceOf(conn)!,
      chat: this.loadChat(),
      history: this.loadHistory(),
    });
    this.broadcastPresence();
  }

  shouldSendProtocolMessages(_conn: Connection, ctx: ConnectionContext) {
    return !isVoiceRequest(ctx.request);
  }

  onClose(conn: Connection<ConnState>) {
    if (conn.state?.voice) return;
    this.emit({ type: "cursor_leave", connectionId: conn.id }, [conn.id]);
    this.broadcastPresence(conn.id);
  }

  async onMessage(conn: Connection<ConnState>, raw: WSMessage) {
    if (typeof raw !== "string" || !conn.state) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    const me = conn.state;
    const author: AuthorRef = { id: me.userId, name: me.name };

    // Cursors are shared by everyone, including viewers.
    if (msg.type === "cursor") {
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y))
        this.emit({ type: "cursor", connectionId: conn.id, x: msg.x, y: msg.y }, [conn.id]);
      return;
    }
    if (msg.type === "cursor_leave") {
      this.emit({ type: "cursor_leave", connectionId: conn.id }, [conn.id]);
      return;
    }

    if (!canEdit(me.role)) {
      this.sendTo(conn, { type: "error", message: "You have view-only access to this project." });
      return;
    }

    switch (msg.type) {
      case "drag":
        if (typeof msg.id === "string" && Number.isFinite(msg.x) && Number.isFinite(msg.y))
          this.emit({ type: "drag", connectionId: conn.id, id: msg.id, x: msg.x, y: msg.y }, [conn.id]);
        return;
      case "ops":
        return this.handleHumanOps(conn, author, msg.ops);
      case "tidy": {
        const pos = layeredLayout(this.state.diagram.nodes, this.state.diagram.edges);
        const ops: Op[] = [...pos].map(([id, p]) => ({ type: "move_node", id, x: p.x, y: p.y }));
        if (ops.length) this.commitHuman(author, ops, "tidied the layout");
        return;
      }
      case "undo":
        return this.undo(author);
      case "chat": {
        const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
        if (!text) return;
        if (this.state.aiBusy) {
          this.sendTo(conn, { type: "error", message: `The AI is still working on ${this.state.aiBusy.for}'s request. Try again in a moment.` });
          return;
        }
        // Don't block this socket's message loop on the model call.
        this.ctx.waitUntil(this.runAiTurn(author, text, Array.isArray(msg.selection) ? msg.selection.filter((x): x is string => typeof x === "string") : []));
        return;
      }
      case "review":
        return this.startReview(conn, author);
    }
  }

  beforeCallStart(conn: Connection<ConnState>) {
    return !!conn.state && canEdit(conn.state.role);
  }

  afterTranscribe(text: string) {
    return text.trim().length < 3 ? null : text;
  }

  async onTurn(text: string, ctx: VoiceTurnContext) {
    const me = (ctx.connection as Connection<ConnState>).state;
    // text_message skips beforeCallStart, so the role check is repeated here.
    if (!me || !canEdit(me.role)) return "You have view-only access, so I can't change this diagram.";
    if (this.state.aiBusy) return `I'm still working on ${this.state.aiBusy.for}'s request. Ask me again in a moment.`;
    const run = () => this.runAiTurn({ id: me.userId, name: me.name }, text);
    const filler = wantsAnswerOnly(text) ? "Let me take a look. " : "On it, drawing that now. ";
    // The filler must end in ". " and be 10+ chars or the TTS splitter holds it until the end.
    // ctx.signal is ignored: an interruption should stop the speech, not half-finish the edits.
    return (async function* () {
      yield filler;
      yield speakable(await run());
    })();
  }

  /* ---------------- human edits ---------------- */

  private handleHumanOps(conn: Connection<ConnState>, author: AuthorRef, ops: unknown) {
    const parsed = OpListSchema.safeParse(ops);
    if (!parsed.success) {
      this.sendTo(conn, { type: "error", message: "That edit was invalid and was not applied." });
      return;
    }
    this.commitHuman(author, parsed.data);
  }

  private commitHuman(author: AuthorRef, ops: Op[], summaryOverride?: string) {
    const before = this.state.diagram;
    const r = applyOps(before, ops, author, { newId });
    if (!r.changed) return;
    const summary = summaryOverride ?? summarize(r.lines);
    this.pushSnapshot(before, summary, author.name);
    this.setDiagram(r.diagram, { summary, by: author.name });
    this.addHistory(author, summary);
    // Remember what people did so the AI can acknowledge it next turn (moves aren't interesting).
    for (const line of r.lines) if (!line.startsWith("move ")) this.sql`INSERT INTO pending_changes (text) VALUES (${`${author.name}: ${line}`})`;
  }

  private undo(author: AuthorRef) {
    const rows = this.sql<{ seq: number; summary: string; by_name: string; diagram: string }>`SELECT * FROM snapshots ORDER BY seq DESC LIMIT 2`;
    const last = rows[0];
    if (!last) return;
    this.sql`DELETE FROM snapshots WHERE seq = ${last.seq}`;
    const prev = rows[1];
    const diagram = JSON.parse(last.diagram) as Diagram;
    this.setDiagram(diagram, prev ? { summary: prev.summary, by: prev.by_name } : null);
    this.addHistory(author, `undid “${last.summary}”`);
  }

  /* ---------------- AI ---------------- */

  private async runAiTurn(author: AuthorRef, text: string, selectionIds: string[] = []): Promise<string> {
    const now = Date.now();
    const before = this.state.diagram;
    const selection = selectionIds
      .map((id) => before.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .slice(0, 20)
      .map((n) => ({ id: n.id, label: n.label }));
    this.upsertChat({
      id: nanoid(10),
      role: "user",
      author,
      text,
      context: selection.length ? `About: ${selection.map((s) => s.label).join(", ")}` : undefined,
      createdAt: now,
    });
    const aiMsg: ChatMessage = { id: nanoid(10), role: "ai", author: AI_AUTHOR, text: "", ops: [], status: "thinking", phase: "Reading the diagram", createdAt: now + 1 };
    this.upsertChat(aiMsg);
    this.setState({ ...this.state, aiBusy: { for: author.name }, highlights: {} });

    // Everything the AI changes this turn goes into one undo step.
    const startedEmpty = before.nodes.length === 0;
    const added = new Set<string>();
    const idMap = new Map<string, string>();
    const lines: string[] = [];
    const skipped: string[] = [];
    let snapshotSeq: number | null = null;

    const applyAi = (op: Op) => {
      if (snapshotSeq === null) snapshotSeq = this.pushSnapshot(before, "AI edits", AI_AUTHOR.name);
      const remap = (ref: string) => idMap.get(ref) ?? ref;
      let step: Op = op;
      if (op.type === "connect") step = { ...op, source: remap(op.source), target: remap(op.target) };
      else if (op.type === "update_node" || op.type === "remove_node" || op.type === "move_node") step = { ...op, id: remap(op.id) };
      const r = applyOps(this.state.diagram, [step], AI_AUTHOR, { lenient: true, newId });
      skipped.push(...r.errors);
      const newId0 = r.addedNodeIds[0];
      if (op.type === "add_node" && newId0) {
        if (op.id) idMap.set(op.id, newId0);
        idMap.set(op.label, newId0);
        added.add(newId0);
      }
      if (!r.changed) return;
      let d = r.diagram;
      // On a blank canvas, keep the whole drawing laid out as it grows.
      if (startedEmpty) d = withLayout(d);
      this.setDiagram(d, this.state.undo);
      lines.push(...r.lines);
      aiMsg.ops = [...lines];
      aiMsg.phase = "Drawing";
      this.upsertChatThrottled(aiMsg);
    };

    try {
      const pending = this.sql<{ seq: number; text: string }>`SELECT * FROM pending_changes ORDER BY seq`;
      const maxSeq = pending.length ? pending[pending.length - 1]!.seq : 0;
      const result = await runChatTurn(
        this.env.AI,
        {
          diagram: before,
          chat: this.loadChat(30).filter((m) => m.id !== aiMsg.id),
          humanChanges: pending.map((p) => p.text),
          userName: author.name,
          text,
          selection,
        },
        {
          onOp: applyAi,
          onReply: (t) => {
            aiMsg.text = t;
            aiMsg.phase = undefined;
            this.upsertChatThrottled(aiMsg);
          },
        },
      );
      this.sql`DELETE FROM pending_changes WHERE seq <= ${maxSeq}`;
      skipped.push(...result.rejected);
      aiMsg.text = result.reply;

      // Second look at what was just drawn.
      let checkNote = "";
      if (result.mode === "edit" && added.size) {
        aiMsg.phase = "Checking my work";
        this.upsertChat(aiMsg);
        checkNote = await this.selfCheck(text, added, applyAi);
      }

      // Highlights may name boxes by id or label.
      const highlights: Record<string, Severity> = {};
      for (const [ref, sev] of Object.entries(result.highlights)) {
        const id = idMap.get(ref) ?? ref;
        const n = this.state.diagram.nodes.find((x) => x.id === id) ?? this.state.diagram.nodes.find((x) => x.label.toLowerCase() === ref.toLowerCase());
        if (n) highlights[n.id] = sev;
      }

      const applied = lines.length;
      if (applied) {
        const summary = summarize(lines);
        this.sql`UPDATE snapshots SET summary = ${summary} WHERE seq = ${snapshotSeq}`;
        this.setState({ ...this.state, undo: { summary, by: AI_AUTHOR.name } });
        this.addHistory(AI_AUTHOR, summary);
      } else if (snapshotSeq !== null) {
        this.sql`DELETE FROM snapshots WHERE seq = ${snapshotSeq}`;
      }

      aiMsg.status = "done";
      aiMsg.phase = undefined;
      aiMsg.meta = [
        "Llama 3.3",
        result.mode === "answer" ? "answer only" : applied ? `${applied} edit${applied > 1 ? "s" : ""}` : "no edits",
        checkNote,
        skipped.length ? `${skipped.length} invalid edit${skipped.length > 1 ? "s" : ""} skipped` : "",
      ].filter(Boolean).join(" \u00B7 ");
      this.upsertChat(aiMsg);
      this.setState({ ...this.state, highlights });
    } catch (err) {
      console.error("AI turn failed", err);
      aiMsg.status = "error";
      aiMsg.phase = undefined;
      aiMsg.text = lines.length
        ? "Something went wrong partway through. The edits above were applied; Undo removes them."
        : "I couldn't reach the AI model just now. Your diagram is unchanged. Try again in a moment.";
      this.upsertChat(aiMsg);
      if (lines.length) this.setState({ ...this.state, undo: { summary: summarize(lines), by: AI_AUTHOR.name } });
    } finally {
      this.setState({ ...this.state, aiBusy: null });
    }
    return aiMsg.text;
  }

  /**
   * Checks what the AI just added: merges obvious duplicates, wires up boxes it
   * forgot to connect, and for bigger designs asks the model to review itself.
   * Returns a short note for the message footer.
   */
  private async selfCheck(request: string, added: Set<string>, applyAi: (op: Op) => void): Promise<string> {
    let fixed = 0;
    const count = () => this.state.version;

    // 1. Duplicates of boxes that already existed before this turn.
    const d0 = this.state.diagram;
    for (const id of [...added]) {
      const n = d0.nodes.find((x) => x.id === id);
      if (!n) continue;
      const twin = d0.nodes.find((x) => x.id !== id && !added.has(x.id) && x.kind === n.kind && slug(x.label) === slug(n.label));
      if (!twin) continue;
      for (const e of d0.edges) {
        if (e.source === id && e.target !== twin.id) applyAi({ type: "connect", source: twin.id, target: e.target, label: e.label });
        if (e.target === id && e.source !== twin.id) applyAi({ type: "connect", source: e.source, target: twin.id, label: e.label });
      }
      applyAi({ type: "remove_node", id });
      added.delete(id);
      fixed++;
    }

    // 2. Boxes left unconnected.
    const isolated = () => {
      const d = this.state.diagram;
      return [...added].filter((id) => d.nodes.some((n) => n.id === id) && !d.edges.some((e) => e.source === id || e.target === id));
    };
    if (isolated().length) {
      try {
        const v = count();
        for (const op of await connectIsolated(this.env.AI, this.state.diagram, isolated())) applyAi(op);
        if (count() !== v) fixed++;
      } catch (e) {
        console.warn("connect follow-up failed", e);
      }
    }

    // 3. For whole designs, a strict second opinion from the model.
    let note = "";
    if (added.size >= 4) {
      try {
        const v = count();
        const check = await verifyDesign(this.env.AI, request, this.state.diagram, added);
        for (const op of check.fixes) {
          applyAi(op);
          await sleep(120);
        }
        if (count() !== v) {
          fixed++;
          note = check.note;
        }
      } catch (e) {
        console.warn("self-check failed", e);
      }
    }
    if (!fixed) return "self-check passed";
    return note && !/looks good/i.test(note) ? `self-check: ${note.replace(/\.$/, "").toLowerCase()}` : "self-check fixed issues";
  }

  /* ---------------- design review (Workflow) ---------------- */

  private async startReview(conn: Connection<ConnState>, author: AuthorRef) {
    if (this.state.review.status === "running") {
      this.sendTo(conn, { type: "error", message: "A review is already running." });
      return;
    }
    if (!this.state.diagram.nodes.length) {
      this.sendTo(conn, { type: "error", message: "Add some boxes before running a review." });
      return;
    }
    this.setState({ ...this.state, review: { status: "running", step: REVIEW_STEPS[0], stepIndex: 0, startedBy: author.name } });
    this.upsertChat({ id: nanoid(10), role: "system", author, text: `${author.name} started a design review`, createdAt: Date.now() });
    try {
      await this.runWorkflow("DESIGN_REVIEW", { requestedBy: author.name }, { agentBinding: "CanvasAgent" });
    } catch (err) {
      console.error("could not start review", err);
      this.finishReviewWithError("The review could not start. Try again.");
    }
  }

  /** Called by the workflow (RPC). */
  async getDiagram(): Promise<Diagram> {
    return this.state.diagram;
  }

  /** Called by the workflow (RPC) as it moves through each area. */
  async setReviewStep(stepIndex: number) {
    this.setState({ ...this.state, review: { ...this.state.review, status: "running", stepIndex, step: REVIEW_STEPS[stepIndex] } });
  }

  /** Called by the workflow (RPC) with every finding. */
  async publishReview(findings: Finding[], requestedBy: string) {
    const nodeIds = new Set(this.state.diagram.nodes.map((n) => n.id));
    const live = findings.filter((f) => nodeIds.has(f.nodeId));
    const rank = { critical: 0, warning: 1, tip: 2 } as const;
    live.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const counts = (["critical", "warning", "tip"] as const)
      .map((s) => [s, live.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s === "critical" ? "critical" : s === "warning" ? `warning${n > 1 ? "s" : ""}` : `tip${n > 1 ? "s" : ""}`}`);
    this.setState({
      ...this.state,
      annotations: live.map((f) => ({ nodeId: f.nodeId, severity: f.severity, title: f.title, detail: f.detail })),
      review: { status: "idle" },
    });
    this.upsertChat({
      id: nanoid(10),
      role: "ai",
      author: AI_AUTHOR,
      text: live.length
        ? `Review finished for ${requestedBy}: ${counts.join(", ")}. I pinned each one to its box.`
        : `Review finished for ${requestedBy}. Nothing important to flag.`,
      findings: live,
      status: "done",
      meta: "Workflow · 4 durable steps · Llama 3.3",
      createdAt: Date.now(),
    });
    this.addHistory(AI_AUTHOR, `reviewed the design (${counts.join(", ") || "no issues"})`);
  }

  async onWorkflowError(_name: string, _id: string, error: string) {
    console.error("review workflow failed", error);
    this.finishReviewWithError("The design review failed partway through. Try again.");
  }

  private finishReviewWithError(text: string) {
    this.setState({ ...this.state, review: { status: "idle" } });
    this.upsertChat({ id: nanoid(10), role: "ai", author: AI_AUTHOR, text, status: "error", createdAt: Date.now() });
  }

  /** Called by the Worker when a project is deleted. */
  async destroyCanvas() {
    await this.destroy();
  }

  /* ---------------- helpers ---------------- */

  private setDiagram(diagram: Diagram, undo: CanvasState["undo"]) {
    const ids = new Set(diagram.nodes.map((n) => n.id));
    const highlights = Object.fromEntries(Object.entries(this.state.highlights).filter(([id]) => ids.has(id)));
    this.setState({
      ...this.state,
      diagram,
      annotations: this.state.annotations.filter((a) => ids.has(a.nodeId)),
      highlights,
      version: this.state.version + 1,
      undo,
    });
    this.touchProject();
  }

  private lastTouch = 0;
  /** Keep "Updated 5 min ago" on the project list roughly current (at most once a minute). */
  private touchProject() {
    const now = Date.now();
    if (now - this.lastTouch < 60_000) return;
    this.lastTouch = now;
    this.ctx.waitUntil(
      this.env.DB.prepare("UPDATE project SET updated_at = ? WHERE id = ?").bind(now, this.name).run().catch(() => {}),
    );
  }

  private pushSnapshot(diagram: Diagram, summary: string, byName: string): number {
    this.sql`INSERT INTO snapshots (summary, by_name, diagram) VALUES (${summary}, ${byName}, ${JSON.stringify(diagram)})`;
    const seq = this.sql<{ seq: number }>`SELECT MAX(seq) AS seq FROM snapshots`[0]?.seq ?? 0;
    this.sql`DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT ${MAX_SNAPSHOTS})`;
    return seq;
  }

  private addHistory(by: AuthorRef, summary: string) {
    const entry: HistoryEntry = { id: nanoid(10), at: Date.now(), by, summary };
    this.sql`INSERT INTO history (id, at, data) VALUES (${entry.id}, ${entry.at}, ${JSON.stringify(entry)})`;
    this.sql`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY at DESC LIMIT ${MAX_HISTORY})`;
    this.emit({ type: "history", entry });
  }

  private upsertChat(message: ChatMessage) {
    const pendingTimer = this.chatTimers.get(message.id);
    if (pendingTimer) clearTimeout(pendingTimer);
    this.sql`INSERT OR REPLACE INTO chat (id, created_at, data) VALUES (${message.id}, ${message.createdAt}, ${JSON.stringify(message)})`;
    this.emit({ type: "chat_upsert", message });
  }

  private chatSentAt = new Map<string, number>();
  private chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** For streaming updates: at most ~8 broadcasts a second per message. */
  private upsertChatThrottled(message: ChatMessage) {
    const last = this.chatSentAt.get(message.id) ?? 0;
    const wait = 120 - (Date.now() - last);
    const pendingTimer = this.chatTimers.get(message.id);
    if (pendingTimer) clearTimeout(pendingTimer);
    if (wait <= 0) {
      this.chatSentAt.set(message.id, Date.now());
      this.upsertChat({ ...message });
    } else {
      this.chatTimers.set(message.id, setTimeout(() => {
        this.chatSentAt.set(message.id, Date.now());
        this.upsertChat({ ...message });
      }, wait));
    }
  }

  private loadChat(limit = 100): ChatMessage[] {
    this.sql`DELETE FROM chat WHERE id NOT IN (SELECT id FROM chat ORDER BY created_at DESC LIMIT ${MAX_CHAT})`;
    return this.sql<{ data: string }>`SELECT data FROM chat ORDER BY created_at DESC LIMIT ${limit}`
      .map((r) => JSON.parse(r.data) as ChatMessage)
      .reverse();
  }

  private loadHistory(): HistoryEntry[] {
    return this.sql<{ data: string }>`SELECT data FROM history ORDER BY at DESC LIMIT 100`.map((r) => JSON.parse(r.data) as HistoryEntry);
  }

  private presenceOf(conn: Connection<ConnState>): Presence | null {
    const s = conn.state;
    return s && !s.voice ? { connectionId: conn.id, userId: s.userId, name: s.name, color: s.color, role: s.role } : null;
  }

  private broadcastPresence(excludeId?: string) {
    const users: Presence[] = [];
    for (const c of this.getConnections<ConnState>()) {
      if (c.id === excludeId) continue;
      const p = this.presenceOf(c);
      if (p) users.push(p);
    }
    this.emit({ type: "presence", users });
  }

  private emit(msg: ServerMessage, exclude: string[] = []) {
    const voice = [...this.getConnections<ConnState>()].filter((c) => c.state?.voice).map((c) => c.id);
    this.broadcast(JSON.stringify(msg), [...exclude, ...voice]);
  }

  private sendTo(conn: Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}

/** Applies the automatic layout to every box (used while the AI draws on a blank canvas). */
function withLayout(d: Diagram): Diagram {
  const pos = layeredLayout(d.nodes, d.edges);
  return { ...d, nodes: d.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? {}) })) };
}

// Spoken replies stay short; the full text is in the chat.
function speakable(reply: string): string {
  const plain = reply.replace(/^\s*[•\-*]\s*/gm, "").replace(/\s+/g, " ").trim();
  if (plain.length <= 420) return plain;
  const cut = plain.slice(0, 420);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return `${end > 120 ? cut.slice(0, end + 1) : cut} The rest is in the chat.`;
}
