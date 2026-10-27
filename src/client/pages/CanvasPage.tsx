import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { canEdit as roleCanEdit, type ProjectDetail } from "../../shared/protocol";
import { api } from "../api";
import { Board } from "../canvas/Board";
import { ShareDialog } from "../canvas/ShareDialog";
import { SidePanel } from "../canvas/SidePanel";
import { useCanvas } from "../canvas/useCanvas";
import { useUser } from "../components/RequireAuth";
import { Dialog } from "../components/ui";
import { Logo } from "../icons";

export function CanvasPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.project(projectId).then(setProject).catch((e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(load, [load]);

  if (error)
    return (
      <div className="center">
        <div style={{ display: "grid", gap: 10, textAlign: "center" }}>
          <div className="err">{error}</div>
          <Link className="btn" to="/" style={{ justifySelf: "center" }}>Go to your workspace</Link>
        </div>
      </div>
    );
  if (!project) return <div className="center muted">Opening project…</div>;
  return (
    <ReactFlowProvider>
      <CanvasView key={project.id} project={project} reload={load} />
    </ReactFlowProvider>
  );
}

function CanvasView({ project, reload }: { project: ProjectDetail; reload: () => void }) {
  const user = useUser();
  const live = useCanvas(project.id);
  const { state, me, presence, send, connected, toast } = live;
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  // The server decides the role; until it says hello, fall back to what the API reported.
  const role = me?.role ?? project.role;
  const canEdit = roleCanEdit(role);

  useEffect(() => {
    document.title = `${project.name} · Drawboard`;
    return () => {
      document.title = "Drawboard";
    };
  }, [project.name]);

  // One avatar per person, even with several tabs open.
  const people = [...new Map(presence.map((p) => [p.userId, p])).values()];

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    await api.updateProject(project.id, { name }).catch(() => {});
    setRenaming(false);
    reload();
  };

  return (
    <div className="app">
      <header className="top">
        <Link to={project.guestRole ? "/" : `/w/${project.workspaceId}`} className="brand" title="Back to projects">
          <Logo />
          <b>Drawboard</b>
        </Link>
        <div className="crumbs">
          {!project.guestRole && <Link to={`/w/${project.workspaceId}`}>{project.workspaceName}</Link>}
          {!project.guestRole && <span className="muted">/</span>}
          {canEdit ? (
            <button type="button" className="btn small" style={{ border: 0, padding: 0, background: "none", fontWeight: 600, fontSize: "0.95rem" }} onClick={() => setRenaming(true)} title="Rename project">
              {project.name}
            </button>
          ) : (
            <b>{project.name}</b>
          )}
          {state && <span className="ver">v{state.version}</span>}
        </div>
        <span className="spacer" />
        <div className="people" aria-label="People here now">
          {people.map((p) => (
            <span key={p.userId} className="pp" style={{ background: p.color }} title={`${p.name}${p.userId === user.id ? " (you)" : ""} · ${p.role}`}>
              {(p.name.trim()[0] ?? "?").toUpperCase()}
            </span>
          ))}
          <span className="pp ai" title="Drawboard AI">AI</span>
        </div>
        {canEdit && (
          <button
            className="btn"
            type="button"
            disabled={!state?.undo || !connected}
            onClick={() => send({ type: "undo" })}
            title={state?.undo ? `Undo: ${state.undo.summary} (${state.undo.by})` : "Nothing to undo"}
          >
            Undo
          </button>
        )}
        {canEdit && (
          <button
            className="btn primary"
            type="button"
            disabled={!state || !connected || state.review.status === "running" || !state.diagram.nodes.length}
            onClick={() => send({ type: "review" })}
          >
            {state?.review.status === "running" ? "Reviewing…" : "Review design"}
          </button>
        )}
        <button className="btn" type="button" onClick={() => setSharing(true)}>Share</button>
      </header>

      {!state ? (
        <div className="center muted">Connecting to the canvas…</div>
      ) : (
        <main className="main">
          <Board
            state={state}
            canEdit={canEdit}
            connected={connected}
            send={send}
            presence={presence}
            cursors={live.cursors}
            remoteDrags={live.remoteDrags}
          />
          <SidePanel
            projectId={project.id}
            meId={user.id}
            state={state}
            chat={live.chat}
            history={live.history}
            canEdit={canEdit}
            connected={connected}
            onSend={(text) => send({ type: "chat", text })}
            onReview={() => send({ type: "review" })}
            showToast={live.showToast}
          />
        </main>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      {sharing && <ShareDialog project={project} onClose={() => setSharing(false)} onChanged={reload} />}
      {renaming && (
        <Dialog title="Rename project" onClose={() => setRenaming(false)}>
          <form onSubmit={rename} className="row">
            <input id="project-rename" className="input" style={{ flex: 1 }} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!name.trim()}>Save</button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
