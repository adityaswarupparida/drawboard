import { useEffect, useRef, useState, type FormEvent } from "react";
import { AI_AUTHOR, colorFor, type CanvasState, type ChatMessage, type HistoryEntry } from "../../shared/protocol";
import { useVoiceAgent } from "agents/voice/react";
import { Avatar, clock } from "../components/ui";
import { MicIcon } from "../icons";

interface Props {
  projectId: string;
  meId: string;
  state: CanvasState;
  chat: ChatMessage[];
  history: HistoryEntry[];
  canEdit: boolean;
  connected: boolean;
  selection: { id: string; label: string }[];
  onClearSelection: () => void;
  onSend: (text: string, selection?: string[]) => void;
  onReview: () => void;
  showToast: (t: string) => void;
}

const EMPTY_PROMPTS = [
  "Design a URL shortener for 100M new links a month",
  "Design a chat app like WhatsApp",
  "Design a ride-sharing backend",
];
const FULL_PROMPTS = [
  "What happens if the database goes down?",
  "How would this handle 10x traffic?",
  "Add caching where it helps most",
];

export function SidePanel({ projectId, meId, state, chat, history, canEdit, connected, selection, onClearSelection, onSend: rawSend, onReview, showToast }: Props) {
  // Messages are about the selected boxes, if any.
  const onSend = (t: string) => rawSend(t, selection.length ? selection.map((s) => s.id) : undefined);
  const [tab, setTab] = useState<"chat" | "history">("chat");
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const voice = useLiveVoice(projectId, showToast);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, tab]);

  const busy = !!state.aiBusy;
  const disabled = !canEdit || !connected || busy;
  const prompts = selection.length
    ? [selection.length === 1 ? "Explain what this does" : "Explain how these work together", selection.length === 1 ? "What breaks if this fails?" : "Make these redundant", "What's missing around this?"]
    : state.diagram.nodes.length
      ? FULL_PROMPTS
      : EMPTY_PROMPTS;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <aside className="side" aria-label="Chat and history">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Chat</button>
        <button type="button" role="tab" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          History <span>{history.length || ""}</span>
        </button>
      </div>

      {tab === "chat" ? (
        <div className="chat" ref={listRef} aria-live="polite">
          {!chat.length && (
            <div className="sys">
              {canEdit ? "Ask the AI to design something, change the diagram, or explain a tradeoff. Everyone in this project sees the conversation." : "The conversation about this design will show up here."}
            </div>
          )}
          {chat.map((m) => (
            <Message key={m.id} m={m} mine={m.author.id === meId} />
          ))}
        </div>
      ) : (
        <ol className="hist">
          {!history.length && <li className="muted" style={{ display: "block", border: 0 }}>No changes yet.</li>}
          {history.map((h) => (
            <li key={h.id}>
              <i style={{ background: h.by.ai ? "var(--ai)" : colorFor(h.by.id) }} />
              <span><b>{h.by.ai ? "AI" : h.by.name}</b> {h.summary}</span>
              <time>{clock(h.at)}</time>
            </li>
          ))}
        </ol>
      )}

      <div className="composer">
        {canEdit ? (
          <>
            <div className="chips">
              {prompts.map((p) => (
                <button key={p} type="button" className="chip" disabled={disabled} onClick={() => onSend(p)}>{p}</button>
              ))}
              {state.diagram.nodes.length > 0 && (
                <button type="button" className="chip" disabled={!connected || state.review.status === "running"} onClick={onReview}>Review this design</button>
              )}
            </div>
            {voice.on && (
              <div className="listen live">
                <span className="level" style={{ transform: `scaleY(${0.25 + Math.min(1, voice.level * 8)})` }} />
                <span>{voice.label}</span>
                <button type="button" className="btn small" onClick={voice.stop}>End</button>
              </div>
            )}
            {selection.length > 0 && (
              <div className="selchip">
                <span>
                  Asking about <b>{selection.length === 1 ? selection[0]!.label : `${selection.length} selected boxes`}</b>
                </span>
                <button type="button" onClick={onClearSelection} aria-label="Clear selection">Clear</button>
              </div>
            )}
            {busy && <div className="listen">The AI is working on {state.aiBusy!.for}'s request…</div>}
            <form onSubmit={submit}>
              <button
                type="button"
                className={`mic${voice.on ? " on" : ""}`}
                onClick={voice.on ? voice.stop : voice.start}
                disabled={!canEdit || !connected}
                aria-label={voice.on ? "End voice conversation" : "Talk with the AI"}
                title={voice.on ? "End voice conversation" : "Talk with the AI (hands-free)"}
              >
                <MicIcon />
              </button>
              <input
                id="chat-input"
                className="input"
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                placeholder={selection.length ? `Ask about or change ${selection.length === 1 ? selection[0]!.label : "the selected boxes"}` : "Ask a question or describe a change"}
                aria-label="Message the AI"
                disabled={!canEdit || !connected}
              />
              <button className="send" type="submit" disabled={disabled || !text.trim()}>Send</button>
            </form>
          </>
        ) : (
          <div className="muted" style={{ fontSize: "0.86rem" }}>You have view-only access, so you can't chat with the AI here.</div>
        )}
      </div>
    </aside>
  );
}

function Message({ m, mine }: { m: ChatMessage; mine: boolean }) {
  if (m.role === "system") return <div className="sys">{m.text}</div>;
  if (m.role === "ai") {
    return (
      <div className={`m ai${m.status === "error" ? " error" : ""}`}>
        <div className="mh">
          <span className="pp ai sm">AI</span>
          <b>{AI_AUTHOR.name}</b>
        </div>
        {m.ops && m.ops.length > 0 && (
          <ul className="ops">
            {m.ops.slice(0, 12).map((o, i) => (
              <li key={i}>{o}</li>
            ))}
            {m.ops.length > 12 && <li>{m.ops.length - 12} more edit{m.ops.length - 12 === 1 ? "" : "s"}</li>}
          </ul>
        )}
        {m.text && <p className={m.status === "thinking" && !m.phase ? "typing" : undefined}>{m.text}</p>}
        {m.status === "thinking" && (m.phase || !m.text) && (
          <div className="think">
            <span className="dots"><i /><i /><i /></span>
            {m.phase ?? "Thinking"}…
          </div>
        )}
        {m.findings && m.findings.length > 0 && (
          <ul className="rlist">
            {m.findings.map((f, i) => (
              <li key={i}>
                <span className={`sev ${f.severity}`}>{f.severity} · {f.area} · {f.nodeLabel}</span>
                <span><b>{f.title}.</b> {f.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {m.meta && <div className="meta">{m.meta}</div>}
      </div>
    );
  }
  return (
    <div className={`m ${mine ? "mine" : "other"}`}>
      <div className="mh">
        <Avatar id={m.author.id} name={m.author.name} small />
        <b>{mine ? "You" : m.author.name}</b>
        <span>{clock(m.createdAt)}</span>
      </div>
      <p>{m.text}</p>
      {m.context && <span className="mctx">{m.context}</span>}
    </div>
  );
}

/**
 * Hands-free voice: the SDK streams mic audio to the canvas agent on a second socket,
 * which transcribes turns, runs them as chat requests and speaks a short reply.
 */
function useLiveVoice(projectId: string, onError: (msg: string) => void) {
  const [on, setOn] = useState(false);
  const started = useRef(false);
  const voice = useVoiceAgent({ agent: "canvas-agent", name: projectId, query: { voice: "1" }, enabled: on });

  useEffect(() => {
    if (!on || !voice.connected || started.current) return;
    started.current = true;
    voice.startCall().catch(() => {
      onError("Couldn't start the microphone. Allow mic access in your browser and try again.");
      setOn(false);
    });
  }, [on, voice.connected, voice, onError]);

  useEffect(() => {
    if (voice.error && on) onError(voice.error);
  }, [voice.error, on, onError]);

  const stop = () => {
    voice.endCall();
    started.current = false;
    setOn(false);
  };

  const label = !voice.connected
    ? "Connecting…"
    : voice.interimTranscript
      ? `\u201C${voice.interimTranscript}\u201D`
      : voice.status === "thinking"
        ? "Working on it…"
        : voice.status === "speaking"
          ? "Speaking… talk to interrupt"
          : "Listening. Just talk.";

  return { on, start: () => setOn(true), stop, label, level: voice.audioLevel };
}
