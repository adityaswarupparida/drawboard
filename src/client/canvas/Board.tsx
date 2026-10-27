import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnDelete,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABEL, NODE_H, NODE_KINDS, NODE_W, type NodeKind } from "../../shared/diagram";
import { REVIEW_STEPS, type CanvasState, type ClientMessage, type Presence } from "../../shared/protocol";
import { DiagramNodeComponent, type DiagramFlowNode } from "./DiagramNode";
import { useThrottle, type XY } from "./useCanvas";

const nodeTypes = { dnode: DiagramNodeComponent };

interface Props {
  state: CanvasState;
  canEdit: boolean;
  connected: boolean;
  send: (m: ClientMessage) => void;
  presence: Presence[];
  cursors: Record<string, XY>;
  remoteDrags: Record<string, XY>;
  selNodes: string[];
  setSelNodes: React.Dispatch<React.SetStateAction<string[]>>;
  /** Walkthrough spotlight: a box id, "all" for the overview, or null when no tour is running. */
  tourFocus: string | null;
  onNodeClick: (id: string) => void;
  overlay?: React.ReactNode;
}

export function Board({ state, canEdit, connected, send, presence, cursors, remoteDrags, selNodes, setSelNodes, tourFocus, onNodeClick, overlay }: Props) {
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const diagram = state.diagram;
  const [localPos, setLocalPos] = useState<Record<string, XY>>({});
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [addKind, setAddKind] = useState<NodeKind>("service");
  const [draft, setDraft] = useState("");
  const labelRef = useRef<HTMLInputElement>(null);
  const prevIds = useRef<Set<string> | null>(null);
  const pendingSelect = useRef<string | null>(null);

  useEffect(() => {
    const ids = new Set(diagram.nodes.map((n) => n.id));
    const before = prevIds.current;
    prevIds.current = ids;
    if (!before) return;
    const added = [...ids].filter((id) => !before.has(id));
    if (!added.length) return;
    setFresh((s) => new Set([...s, ...added]));
    const t = setTimeout(() => setFresh((s) => {
      const next = new Set(s);
      added.forEach((a) => next.delete(a));
      return next;
    }), 1900);
    if (pendingSelect.current && ids.has(pendingSelect.current)) {
      setSelNodes([pendingSelect.current]);
      setSelEdges([]);
      pendingSelect.current = null;
      setTimeout(() => labelRef.current?.select(), 30);
    }
    if (before.size === 0) setTimeout(() => rf.fitView({ padding: 0.25, duration: 400, maxZoom: 1 }), 60);
    return () => clearTimeout(t);
  }, [diagram.nodes, rf, setSelNodes]);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !state.aiBusy && diagram.nodes.length) rf.fitView({ padding: 0.25, duration: 400, maxZoom: 1 });
    wasBusy.current = !!state.aiBusy;
  }, [state.aiBusy, diagram.nodes.length, rf]);

  const nodesRef = useRef(diagram.nodes);
  nodesRef.current = diagram.nodes;
  // Pan only when the stop changes, not on every edit while a tour is open.
  useEffect(() => {
    if (!tourFocus) return;
    if (tourFocus === "all") {
      rf.fitView({ padding: 0.3, duration: 600, maxZoom: 1 });
      return;
    }
    const n = nodesRef.current.find((x) => x.id === tourFocus);
    if (!n) return;
    const zoom = 1.05;
    // Aim a little below the box so it sits above the walkthrough card.
    rf.setCenter(n.x + NODE_W / 2, n.y + NODE_H / 2 + 130 / zoom, { zoom, duration: 600 });
  }, [tourFocus, rf]);

  const spot = useMemo(() => {
    if (!tourFocus || tourFocus === "all") return null;
    const near = new Set([tourFocus]);
    for (const e of diagram.edges) {
      if (e.source === tourFocus) near.add(e.target);
      if (e.target === tourFocus) near.add(e.source);
    }
    return near;
  }, [tourFocus, diagram.edges]);

  // Keep the local drag position until the server echoes it back, so boxes don't snap back.
  useEffect(() => {
    setLocalPos((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, p] of Object.entries(prev)) {
        const n = diagram.nodes.find((x) => x.id === id);
        if (!n || (Math.abs(n.x - p.x) < 1 && Math.abs(n.y - p.y) < 1)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setSelNodes((s) => s.filter((id) => diagram.nodes.some((n) => n.id === id)));
    setSelEdges((s) => s.filter((id) => diagram.edges.some((e) => e.id === id)));
  }, [diagram, setSelNodes]);

  const nodes: DiagramFlowNode[] = useMemo(() => {
    const ann = new Map<string, CanvasState["annotations"][number]>();
    for (const a of state.annotations) if (!ann.has(a.nodeId)) ann.set(a.nodeId, a);
    return diagram.nodes.map((n) => ({
      id: n.id,
      type: "dnode",
      position: localPos[n.id] ?? remoteDrags[n.id] ?? { x: n.x, y: n.y },
      data: {
        node: n,
        annotation: ann.get(n.id),
        highlight: state.highlights[n.id],
        fresh: fresh.has(n.id),
        tour: !spot ? undefined : n.id === tourFocus ? "on" : spot.has(n.id) ? undefined : "dim",
      },
      selected: selNodes.includes(n.id),
      draggable: canEdit,
      connectable: canEdit,
      deletable: canEdit,
      width: NODE_W,
      height: NODE_H,
    }));
  }, [diagram.nodes, state.annotations, state.highlights, localPos, remoteDrags, fresh, selNodes, canEdit, spot, tourFocus]);

  const edges: Edge[] = useMemo(() => {
    const pos = new Map(nodes.map((n) => [n.id, n.position]));
    return diagram.edges.map((e) => {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      let sourceHandle = "s-right";
      let targetHandle = "t-left";
      if (a && b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          sourceHandle = dx > 0 ? "s-right" : "s-left";
          targetHandle = dx > 0 ? "t-left" : "t-right";
        } else {
          sourceHandle = dy > 0 ? "s-bottom" : "s-top";
          targetHandle = dy > 0 ? "t-top" : "t-bottom";
        }
      }
      const hot = spot && (e.source === tourFocus || e.target === tourFocus);
      return {
        id: e.id,
        className: spot ? (hot ? "tour-hot" : "tour-dim") : undefined,
        animated: !!hot,
        source: e.source,
        target: e.target,
        sourceHandle,
        targetHandle,
        label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        selected: selEdges.includes(e.id),
        deletable: canEdit,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      };
    });
  }, [diagram.edges, nodes, selEdges, canEdit, spot, tourFocus]);

  const sendDrag = useThrottle((id: string, p: XY) => send({ type: "drag", id, x: p.x, y: p.y }), 60);
  const sendCursor = useThrottle((p: XY) => send({ type: "cursor", x: Math.round(p.x), y: Math.round(p.y) }), 50);

  const onNodesChange = useCallback(
    (changes: NodeChange<DiagramFlowNode>[]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position && c.dragging) {
          const p = c.position;
          setLocalPos((prev) => ({ ...prev, [c.id]: p }));
          sendDrag(c.id, p);
        } else if (c.type === "select") {
          setSelNodes((s) => (c.selected ? (s.includes(c.id) ? s : [...s, c.id]) : s.filter((x) => x !== c.id)));
        }
      }
    },
    [sendDrag, setSelNodes],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type === "select")
        setSelEdges((s) => (c.selected ? (s.includes(c.id) ? s : [...s, c.id]) : s.filter((x) => x !== c.id)));
    }
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, _node: DiagramFlowNode, dragged: DiagramFlowNode[]) => {
      const ops = dragged.map((n) => ({ type: "move_node" as const, id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }));
      if (ops.length) send({ type: "ops", ops });
    },
    [send],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target && c.source !== c.target) send({ type: "ops", ops: [{ type: "connect", source: c.source, target: c.target }] });
    },
    [send],
  );

  const onDelete: OnDelete<DiagramFlowNode, Edge> = useCallback(
    ({ nodes: dn, edges: de }) => {
      const gone = new Set(dn.map((n) => n.id));
      const ops = [
        ...de.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => ({ type: "disconnect" as const, id: e.id })),
        ...dn.map((n) => ({ type: "remove_node" as const, id: n.id })),
      ];
      if (ops.length) send({ type: "ops", ops });
    },
    [send],
  );

  const selNode = selNodes.length === 1 ? diagram.nodes.find((n) => n.id === selNodes[0]) : undefined;
  const selEdge = !selNode && selEdges.length === 1 ? diagram.edges.find((e) => e.id === selEdges[0]) : undefined;
  useEffect(() => {
    setDraft(selNode?.label ?? selEdge?.label ?? "");
  }, [selNode?.id, selNode?.label, selEdge?.id, selEdge?.label]);

  const addBox = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const center = rect ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    const id = `n-${Math.random().toString(36).slice(2, 8)}`;
    pendingSelect.current = id;
    const jitter = () => Math.round((Math.random() - 0.5) * 60);
    send({ type: "ops", ops: [{ type: "add_node", id, kind: addKind, label: KIND_LABEL[addKind], x: Math.round(center.x - NODE_W / 2) + jitter(), y: Math.round(center.y - NODE_H / 2) + jitter() }] });
  };
  const commitLabel = () => {
    const v = draft.trim();
    if (selNode && v && v !== selNode.label) send({ type: "ops", ops: [{ type: "update_node", id: selNode.id, label: v.slice(0, 40) }] });
    if (selEdge && v !== (selEdge.label ?? "")) send({ type: "ops", ops: [{ type: "update_edge", id: selEdge.id, label: v.slice(0, 24) }] });
  };

  const review = state.review;
  const empty = diagram.nodes.length === 0;

  return (
    <section className="board" aria-label="Design canvas">
      <div className="tools">
        {canEdit ? (
          <>
            <div className="tgroup">
              <select className="tbtn" value={addKind} onChange={(e) => setAddKind(e.target.value as NodeKind)} aria-label="Box type">
                {NODE_KINDS.map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
              <button className="tbtn" type="button" onClick={addBox} disabled={!connected}>Add box</button>
              <button className="tbtn" type="button" onClick={() => send({ type: "tidy" })} disabled={!connected || empty} title="Arrange boxes left to right">Tidy up</button>
            </div>
            {(selNode || selEdge) && (
              <div className="tgroup">
                <span className="label">{selNode ? "Box" : "Connection"}</span>
                <input
                  ref={labelRef}
                  className="lbl-input"
                  value={draft}
                  placeholder={selEdge ? "Label (optional)" : "Name"}
                  maxLength={selEdge ? 24 : 40}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitLabel}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    e.stopPropagation();
                  }}
                  aria-label={selNode ? "Box name" : "Connection label"}
                />
                {selNode && (
                  <select
                    className="tbtn"
                    value={selNode.kind}
                    aria-label="Box type"
                    onChange={(e) => send({ type: "ops", ops: [{ type: "update_node", id: selNode.id, kind: e.target.value as NodeKind }] })}
                  >
                    {NODE_KINDS.map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                )}
                <button
                  className="tbtn danger"
                  type="button"
                  onClick={() =>
                    send({ type: "ops", ops: [selNode ? { type: "remove_node", id: selNode.id } : { type: "disconnect", id: selEdge!.id }] })
                  }
                >
                  Delete
                </button>
              </div>
            )}
          </>
        ) : (
          <span className="viewer-note">View only. Ask an owner for editor access to make changes.</span>
        )}
      </div>

      <div
        ref={wrapRef}
        style={{ position: "relative", minHeight: 0 }}
        onMouseMove={(e) => sendCursor(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
        onMouseLeave={() => send({ type: "cursor_leave" })}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_, n) => onNodeClick(n.id)}
          onConnect={onConnect}
          onDelete={onDelete}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid)" />
          <Controls showInteractive={false} />
          {!tourFocus && <MiniMap pannable zoomable nodeColor="var(--node-stroke)" maskColor="rgba(120,130,140,0.12)" />}
          <ViewportPortal>
            {Object.entries(cursors).map(([cid, p]) => {
              const u = presence.find((x) => x.connectionId === cid);
              if (!u) return null;
              return (
                <div key={cid} className="cursor" style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
                  <svg width="16" height="20" viewBox="0 0 16 20" style={{ position: "absolute" }}>
                    <path d="M0 0L0 17L4.6 12.6L7.6 19.5L10.2 18.4L7.3 11.6L13.4 11.6Z" fill={u.color} stroke="#fff" strokeWidth="1.2" />
                  </svg>
                  <span style={{ background: u.color }}>{u.name}</span>
                </div>
              );
            })}
          </ViewportPortal>
        </ReactFlow>
        {overlay}
        {empty && (
          <div className="empty-canvas">
            <div>
              <b>This canvas is empty</b>
              {canEdit ? "Describe a system in the chat, like “Design a URL shortener for 100M links a month”, or add a box from the toolbar." : "Nothing has been designed here yet."}
            </div>
          </div>
        )}
      </div>

      {review.status === "running" && (
        <div className="review" role="status">
          <h3>Design review</h3>
          <p>Workflow · started by {review.startedBy}</p>
          <ol>
            {REVIEW_STEPS.map((s, i) => (
              <li key={s} className={i < (review.stepIndex ?? 0) ? "done" : i === (review.stepIndex ?? 0) ? "run" : ""}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="status">
        <span className="mono">{diagram.nodes.length} boxes · {diagram.edges.length} connections</span>
        <span className={`conn-state ${connected ? "" : "off"}`}>{connected ? "live" : "reconnecting…"}</span>
        <span className="hint">Drag between the dots on two boxes to connect them. Select something and press Delete to remove it.</span>
      </div>
    </section>
  );
}
