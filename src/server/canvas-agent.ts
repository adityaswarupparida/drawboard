import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { nanoid } from "nanoid";
import { applyOps, summarize } from "../shared/apply";
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
import { runDesignTurn } from "./ai";
import type { Env } from "./env";

type ConnState = { userId: string; name: string; role: Role; color: string };

const MAX_CHAT = 200;
const MAX_HISTORY = 300;
const MAX_SNAPSHOTS = 50;
const AI_STEP_MS = 170;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = () => nanoid(8);

/**
 * One instance per project. It owns the diagram, chat and change history, and
 * is the single source of truth: every edit (human or AI) is validated here
 * and then broadcast to everyone connected.
 */
export class CanvasAgent extends Agent<Env, CanvasState> {
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
    // If the object restarted mid AI turn, clear the stale "AI is working" flag.
    if (this.state.aiBusy) this.setState({ ...this.state, aiBusy: null });
  }

  /** Clients never write state directly; all changes arrive as validated messages. */
  validateStateChange(_next: CanvasState, source: Connection | "server") {
    if (source !== "server") throw new Error("Edits must be sent as ops");
  }

  /* ---------------- connections ---------------- */

  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const userId = h.get("x-user-id");
    const role = h.get("x-role") as Role | null;
    if (!userId || !role) {
      conn.close(4401, "Not authorized");
      return;
    }
    const name = decodeURIComponent(h.get("x-user-name") ?? "Someone");
    conn.setState({ userId, name, role, color: colorFor(userId) });
    this.sendTo(conn, {
      type: "hello",
      you: this.presenceOf(conn)!,
      chat: this.loadChat(),
      history: this.loadHistory(),
    });
    this.broadcastPresence();
  }

  onClose(conn: Connection<ConnState>) {
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
        this.ctx.waitUntil(this.runAiTurn(author, text));
        return;
      }
      case "review":
        return this.startReview(conn, author);
    }
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

  private async runAiTurn(author: AuthorRef, text: string) {
    const now = Date.now();
    this.upsertChat({ id: nanoid(10), role: "user", author, text, createdAt: now });
    const aiMsg: ChatMessage = { id: nanoid(10), role: "ai", author: AI_AUTHOR, text: "", ops: [], status: "thinking", createdAt: now + 1 };
    this.upsertChat(aiMsg);
    this.setState({ ...this.state, aiBusy: { for: author.name }, highlights: {} });

    try {
      const pending = this.sql<{ seq: number; text: string }>`SELECT * FROM pending_changes ORDER BY seq`;
      const maxSeq = pending.length ? pending[pending.length - 1]!.seq : 0;
      const result = await runDesignTurn(this.env.AI, {
        diagram: this.state.diagram,
        chat: this.loadChat(30).filter((m) => m.id !== aiMsg.id),
        humanChanges: pending.map((p) => p.text),
        userName: author.name,
        text,
      });
      this.sql`DELETE FROM pending_changes WHERE seq <= ${maxSeq}`;

      const before = this.state.diagram;
      let applied = 0;
      const skipped: string[] = [...result.rejected];

      if (result.ops.length) {
        // Work out final positions from the whole batch, then play the edits
        // one by one so everyone watches the diagram being drawn.
        const finalRun = applyOps(before, result.ops, AI_AUTHOR, { lenient: true, newId });
        const finalNodes = finalRun.addedNodeIds.map((id) => finalRun.diagram.nodes.find((n) => n.id === id)!);
        this.pushSnapshot(before, summarize(finalRun.lines), AI_AUTHOR.name);

        const idMap = new Map<string, string>();
        const remap = (ref: string) => idMap.get(ref) ?? ref;
        let addIndex = 0;
        for (const op of result.ops) {
          let step: Op = op;
          if (op.type === "add_node") {
            const pos = finalNodes[addIndex++];
            step = { ...op, x: pos?.x, y: pos?.y };
          } else if (op.type === "connect") step = { ...op, source: remap(op.source), target: remap(op.target) };
          else if (op.type === "update_node" || op.type === "remove_node") step = { ...op, id: remap(op.id) };

          const r = applyOps(this.state.diagram, [step], AI_AUTHOR, { lenient: true, newId });
          skipped.push(...r.errors);
          if (op.type === "add_node" && r.addedNodeIds[0]) {
            if (op.id) idMap.set(op.id, r.addedNodeIds[0]);
            idMap.set(op.label, r.addedNodeIds[0]);
          }
          if (!r.changed) continue;
          applied++;
          this.setDiagram(r.diagram, this.state.undo);
          aiMsg.ops = [...(aiMsg.ops ?? []), ...r.lines];
          this.upsertChat(aiMsg);
          await sleep(AI_STEP_MS);
        }
        if (applied) {
          const summary = summarize(aiMsg.ops ?? []);
          this.setState({ ...this.state, undo: { summary, by: AI_AUTHOR.name } });
          this.addHistory(AI_AUTHOR, summary);
        } else {
          // Nothing applied: drop the snapshot we just pushed.
          this.sql`DELETE FROM snapshots WHERE seq = (SELECT MAX(seq) FROM snapshots)`;
        }
      }

      // Highlights may name boxes by id or label.
      const highlights: Record<string, Severity> = {};
      for (const [ref, sev] of Object.entries(result.highlights)) {
        const n = this.state.diagram.nodes.find((x) => x.id === ref) ?? this.state.diagram.nodes.find((x) => x.label.toLowerCase() === ref.toLowerCase());
        if (n) highlights[n.id] = sev;
      }

      aiMsg.text = result.reply;
      aiMsg.status = "done";
      aiMsg.meta = [
        "Llama 3.3",
        applied ? `${applied} edit${applied > 1 ? "s" : ""}` : "no edits",
        skipped.length ? `${skipped.length} invalid edit${skipped.length > 1 ? "s" : ""} skipped` : "",
      ].filter(Boolean).join(" · ");
      this.upsertChat(aiMsg);
      this.setState({ ...this.state, highlights });
    } catch (err) {
      console.error("AI turn failed", err);
      aiMsg.status = "error";
      aiMsg.text = "I couldn't reach the AI model just now. Your diagram is unchanged. Try again in a moment.";
      this.upsertChat(aiMsg);
    } finally {
      this.setState({ ...this.state, aiBusy: null });
    }
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

  private pushSnapshot(diagram: Diagram, summary: string, byName: string) {
    this.sql`INSERT INTO snapshots (summary, by_name, diagram) VALUES (${summary}, ${byName}, ${JSON.stringify(diagram)})`;
    this.sql`DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT ${MAX_SNAPSHOTS})`;
  }

  private addHistory(by: AuthorRef, summary: string) {
    const entry: HistoryEntry = { id: nanoid(10), at: Date.now(), by, summary };
    this.sql`INSERT INTO history (id, at, data) VALUES (${entry.id}, ${entry.at}, ${JSON.stringify(entry)})`;
    this.sql`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY at DESC LIMIT ${MAX_HISTORY})`;
    this.emit({ type: "history", entry });
  }

  private upsertChat(message: ChatMessage) {
    this.sql`INSERT OR REPLACE INTO chat (id, created_at, data) VALUES (${message.id}, ${message.createdAt}, ${JSON.stringify(message)})`;
    this.emit({ type: "chat_upsert", message });
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
    return s ? { connectionId: conn.id, userId: s.userId, name: s.name, color: s.color, role: s.role } : null;
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

  private emit(msg: ServerMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(msg), exclude);
  }

  private sendTo(conn: Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}
