import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { canEdit, type ProjectSummary, type WorkspaceDetail } from "../../shared/protocol";
import { api } from "../api";
import { TopBar } from "../components/TopBar";
import { Avatar, Dialog, RoleBadge, timeAgo } from "../components/ui";
import { Logo } from "../icons";
import { LAST_WS_KEY } from "./Home";

export function WorkspacePage() {
  const { workspaceId = "" } = useParams();
  const navigate = useNavigate();
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [shared, setShared] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  useEffect(() => {
    setWs(null);
    setError(null);
    api.workspace(workspaceId).then(setWs).catch((e: Error) => setError(e.message));
    try {
      localStorage.setItem(LAST_WS_KEY, workspaceId);
    } catch {
      /* storage blocked */
    }
  }, [workspaceId]);

  useEffect(() => {
    if (ws?.personal) api.sharedWithMe().then(setShared).catch(() => {});
  }, [ws?.personal]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.createProject(workspaceId, name, desc || undefined);
      navigate(`/p/${p.id}`);
    } catch (err) {
      setFormErr((err as Error).message);
    }
  };

  if (error)
    return (
      <div className="page">
        <TopBar />
        <div className="wrap err">{error}</div>
      </div>
    );

  return (
    <div className="page">
      <TopBar current={ws ?? undefined} />
      {!ws ? (
        <div className="wrap muted">Loading…</div>
      ) : (
        <main className="wrap">
          <div className="ws-head">
            <div style={{ display: "grid", gap: 4 }}>
              <span className="label">{ws.personal ? "Personal workspace" : "Workspace"}</span>
              <h1>{ws.name}</h1>
            </div>
            <div className="row" style={{ marginBottom: 4 }}>
              <RoleBadge role={ws.role} />
              <div className="people" title={ws.members.map((m) => m.name).join(", ")}>
                {ws.members.slice(0, 6).map((m) => (
                  <Avatar key={m.userId} id={m.userId} name={m.name} image={m.image} />
                ))}
              </div>
              <span className="muted">{ws.memberCount} {ws.memberCount === 1 ? "member" : "members"}</span>
            </div>
            <span className="spacer" />
            <div className="row">
              <Link className="btn" to={`/w/${ws.id}/settings`}>{ws.role === "viewer" ? "Members" : "Members & sharing"}</Link>
              {canEdit(ws.role) && (
                <button className="btn primary" type="button" onClick={() => setCreating(true)}>New project</button>
              )}
            </div>
          </div>

          <div className="grid">
            {ws.projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
            {canEdit(ws.role) && (
              <button className="card proj new" type="button" onClick={() => setCreating(true)}>
                <span>+ New project</span>
              </button>
            )}
          </div>
          {!ws.projects.length && !canEdit(ws.role) && <p className="muted">No projects here yet.</p>}

          {shared.length > 0 && (
            <>
              <h2 style={{ fontSize: "1rem", margin: "32px 0 12px" }}>Shared with you</h2>
              <div className="grid">
                {shared.map((p) => (
                  <ProjectCard key={p.id} p={p} />
                ))}
              </div>
            </>
          )}
        </main>
      )}

      {creating && (
        <Dialog title="New project" onClose={() => setCreating(false)}>
          <form onSubmit={create} style={{ display: "grid", gap: 10 }}>
            <label>
              <span className="label">Name</span>
              <input id="project-name" className="input" autoFocus required maxLength={60} placeholder="e.g. Payments v2" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span className="label">What are you designing? (optional)</span>
              <textarea id="project-desc" className="input" rows={2} maxLength={280} value={desc} onChange={(e) => setDesc(e.target.value)} />
            </label>
            {formErr && <div className="err">{formErr}</div>}
            <button className="btn primary" type="submit" style={{ justifySelf: "start" }}>Create and open</button>
          </form>
        </Dialog>
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <Link to={`/p/${p.id}`} className="card proj">
      <div className="thumb">
        <span style={{ width: 34, height: 34, display: "block" }}><Logo /></span>
      </div>
      <div className="meta">
        <b>{p.name}</b>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {p.guestRole ? `Shared with you · ${p.guestRole}` : `Updated ${timeAgo(p.updatedAt)}`}
        </span>
        {p.description && <span className="muted" style={{ fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description}</span>}
      </div>
    </Link>
  );
}
