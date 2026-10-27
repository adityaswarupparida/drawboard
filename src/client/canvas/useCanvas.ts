import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CanvasState,
  ChatMessage,
  ClientMessage,
  HistoryEntry,
  Presence,
  ServerMessage,
} from "../../shared/protocol";

export type XY = { x: number; y: number };

/** Live connection to one project's canvas agent. */
export function useCanvas(projectId: string) {
  const [me, setMe] = useState<Presence | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [cursors, setCursors] = useState<Record<string, XY>>({});
  const [remoteDrags, setRemoteDrags] = useState<Record<string, XY>>({});
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const showToast = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      switch (msg.type) {
        case "hello":
          setMe(msg.you);
          setChat(msg.chat);
          setHistory(msg.history);
          break;
        case "chat_upsert":
          setChat((prev) => {
            const i = prev.findIndex((m) => m.id === msg.message.id);
            if (i === -1) return [...prev, msg.message];
            const next = prev.slice();
            next[i] = msg.message;
            return next;
          });
          break;
        case "history":
          setHistory((prev) => [msg.entry, ...prev].slice(0, 200));
          break;
        case "presence":
          setPresence(msg.users);
          setCursors((prev) => {
            const live = new Set(msg.users.map((u) => u.connectionId));
            return Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id)));
          });
          break;
        case "cursor":
          setCursors((prev) => ({ ...prev, [msg.connectionId]: { x: msg.x, y: msg.y } }));
          break;
        case "cursor_leave":
          setCursors((prev) => {
            const next = { ...prev };
            delete next[msg.connectionId];
            return next;
          });
          break;
        case "drag": {
          const { id, x, y } = msg;
          setRemoteDrags((prev) => ({ ...prev, [id]: { x, y } }));
          clearTimeout(dragTimers.current[id]);
          dragTimers.current[id] = setTimeout(
            () => setRemoteDrags((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            }),
            1500,
          );
          break;
        }
        case "error":
          showToast(msg.message);
          break;
      }
    },
    [showToast],
  );

  const agent = useAgent<CanvasState>({
    agent: "canvas-agent",
    name: projectId,
    onMessage,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  const state = agent.state;

  // A committed position from the server replaces any in-flight remote drag.
  useEffect(() => {
    if (!state) return;
    setRemoteDrags((prev) => (Object.keys(prev).length ? {} : prev));
  }, [state?.version]);

  const send = useCallback(
    (m: ClientMessage) => {
      agent.send(JSON.stringify(m));
    },
    [agent],
  );

  return { state, me, chat, history, presence, cursors, remoteDrags, connected, toast, showToast, send };
}

/** Calls fn at most once per `ms`, always delivering the latest arguments. */
export function useThrottle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const last = useRef(0);
  const pending = useRef<A | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback(
    (...args: A) => {
      const now = Date.now();
      const wait = ms - (now - last.current);
      if (wait <= 0) {
        last.current = now;
        fnRef.current(...args);
      } else {
        pending.current = args;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          last.current = Date.now();
          if (pending.current) fnRef.current(...pending.current);
          pending.current = null;
        }, wait);
      }
    },
    [ms],
  );
}
