import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Role, WorkspaceDetail } from "../../shared/protocol";
import { api } from "../api";
import { useUser } from "../components/RequireAuth";
import { TopBar } from "../components/TopBar";
import { Avatar, CopyLink, RoleBadge } from "../components/ui";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including members and deleting the workspace",
  editor: "Create and edit projects, use the AI, invite people",
  viewer: "Watch canvases live and read the chat, no edits",
};

export function WorkspaceSettings() {
  const { workspaceId = "" } = useParams();
  const me = useUser();
  const navigate = useNavigate();
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [invite, setInvite] = useState<{ url: string; expiresAt: number; role: Role } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.workspace(workspaceId).then((w) => {
      setWs(w);
      setName(w.name);
    }).catch((e: Error) => setError(e.message));
  }, [workspaceId]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!ws) return <div className="page"><TopBar /><div className="wrap muted">{error ?? "Loading…"}</div></div>;
  const owner = ws.role === "owner";
  const editor = ws.role !== "viewer";

  return (
    <div className="page">
      <TopBar current={ws} />
      <main className="wrap" style={{ maxWidth: 760, display: "grid", gap: 18 }}>
        <div className="row">
          <Link to={`/w/${ws.id}`} className="btn small">← Back to projects</Link>
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontSize: "1.8rem" }}>{ws.name}</h1>
        {error && <div className="err">{error}</div>}
        {notice && <div className="muted">{notice}</div>}

        <section className="card">
          {owner && (
            <div className="section">
              <span className="label">Workspace name</span>
              <form className="row" onSubmit={(e) => { e.preventDefault(); run(() => api.renameWorkspace(ws.id, name), "Workspace renamed."); }}>
                <input id="ws-rename" className="input" style={{ flex: 1, minWidth: 200 }} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <button className="btn" type="submit" disabled={name.trim() === ws.name || !name.trim()}>Rename</button>
              </form>
            </div>
          )}

          {editor && !ws.personal && (
            <div className="section">
              <span className="label">Invite people</span>
              <p className="muted" style={{ margin: 0 }}>Create a link and send it to a teammate. Anyone with the link can join for 7 days.</p>
              <div className="row">
                <select id="invite-role" className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                  {(owner ? (["editor", "viewer", "owner"] as Role[]) : (["editor", "viewer"] as Role[])).map((r) => (
                    <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>
                  ))}
                </select>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => run(async () => {
                    const r = await api.createInvite({ workspaceId: ws.id, role: inviteRole });
                    setInvite({ url: r.url, expiresAt: r.expiresAt, role: inviteRole });
                  })}
                >
                  Create invite link
                </button>
                <span className="muted" style={{ fontSize: "0.82rem" }}>{ROLE_HELP[inviteRole]}</span>
              </div>
              {invite && (
                <>
                  <CopyLink url={invite.url} />
                  <span className="muted" style={{ fontSize: "0.8rem" }}>Joins as {invite.role}. Expires {new Date(invite.expiresAt).toLocaleDateString()}.</span>
                </>
              )}
            </div>
          )}
          {ws.personal && (
            <div className="section">
              <span className="label">Sharing</span>
              <p className="muted" style={{ margin: 0 }}>
                This is your personal workspace. Share a single project from its Share button, or create a team workspace from the workspace menu to invite people to everything.
              </p>
            </div>
          )}

          <div className="section">
            <span className="label">Members</span>
            <div className="scroll-x">
              <table className="table">
                <tbody>
                  {ws.members.map((m) => (
                    <tr key={m.userId}>
                      <td>
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <Avatar id={m.userId} name={m.name} image={m.image} />
                          <div style={{ minWidth: 0 }}>
                            <div>{m.name}{m.userId === me.id ? " (you)" : ""}</div>
                            <div className="muted" style={{ fontSize: "0.8rem" }}>{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {owner && m.userId !== me.id ? (
                          <select className="input" value={m.role} aria-label={`Role for ${m.name}`} onChange={(e) => run(() => api.setMemberRole(ws.id, m.userId, e.target.value as Role))}>
                            <option value="owner">Owner</option>
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        ) : (
                          <RoleBadge role={m.role} />
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {owner && m.userId !== me.id && (
                          <button className="btn small danger" type="button" onClick={() => run(() => api.removeMember(ws.id, m.userId), `${m.name} was removed.`)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {!ws.personal && (
          <section className="card">
            <div className="section">
              <span className="label">Leave or delete</span>
              <div className="row">
                <button className="btn" type="button" onClick={() => run(async () => { await api.leaveWorkspace(ws.id); navigate("/"); })}>Leave workspace</button>
                {owner && !confirmDelete && <button className="btn danger" type="button" onClick={() => setConfirmDelete(true)}>Delete workspace</button>}
                {owner && confirmDelete && (
                  <>
                    <span className="err">This deletes {ws.projectCount} project{ws.projectCount === 1 ? "" : "s"} for everyone.</span>
                    <button className="btn danger" type="button" onClick={() => run(async () => { await api.deleteWorkspace(ws.id); navigate("/"); })}>Yes, delete it</button>
                    <button className="btn" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </>
                )}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
