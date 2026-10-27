import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectSummary, WorkspaceSummary } from "../../shared/protocol";
import { api } from "../api";
import { authClient } from "../auth-client";
import { Logo } from "../icons";
import { useUser } from "./RequireAuth";
import { Avatar, Dialog } from "./ui";

function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

export function TopBar({ current }: { current?: WorkspaceSummary }) {
  const user = useUser();
  const navigate = useNavigate();
  const [list, setList] = useState<WorkspaceSummary[]>([]);
  const [shared, setShared] = useState<ProjectSummary[]>([]);
  const [wsOpen, setWsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useClickAway(wsOpen, () => setWsOpen(false));
  const userRef = useClickAway(userOpen, () => setUserOpen(false));

  useEffect(() => {
    api.workspaces().then(setList).catch(() => {});
    api.sharedWithMe().then(setShared).catch(() => {});
  }, [current?.id]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const ws = await api.createWorkspace(newName);
      setCreating(false);
      setNewName("");
      navigate(`/w/${ws.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <Logo />
        <b>Drawboard</b>
      </Link>
      <div className="ws-switch" ref={wsRef}>
        <button className="btn" type="button" onClick={() => setWsOpen((o) => !o)} aria-expanded={wsOpen}>
          {current?.name ?? "Workspaces"} <span className="muted">▾</span>
        </button>
        {wsOpen && (
          <div className="menu" role="menu">
            <span className="label" style={{ padding: "6px 10px 2px" }}>Workspaces</span>
            {list.map((w) => (
              <Link key={w.id} to={`/w/${w.id}`} onClick={() => setWsOpen(false)} role="menuitem">
                <span>{w.name}</span>
                <span className="muted">{w.role}</span>
              </Link>
            ))}
            <button type="button" onClick={() => { setCreating(true); setWsOpen(false); }}>+ New workspace</button>
            {shared.length > 0 && (
              <>
                <span className="label" style={{ padding: "8px 10px 2px" }}>Shared with you</span>
                {shared.map((p) => (
                  <Link key={p.id} to={`/p/${p.id}`} onClick={() => setWsOpen(false)} role="menuitem">
                    <span>{p.name}</span>
                    <span className="muted">{p.guestRole}</span>
                  </Link>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <span className="spacer" />
      <div className="ws-switch" ref={userRef}>
        <button className="btn" type="button" onClick={() => setUserOpen((o) => !o)} style={{ padding: "3px 10px 3px 4px" }}>
          <Avatar id={user.id} name={user.name} image={user.image} small />
          {user.name}
        </button>
        {userOpen && (
          <div className="menu" style={{ left: "auto", right: 0 }} role="menu">
            <span className="muted" style={{ padding: "6px 10px", fontSize: "0.82rem" }}>{user.email}</span>
            <button
              type="button"
              onClick={async () => {
                await authClient.signOut();
                navigate("/login");
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>

      {creating && (
        <Dialog title="New workspace" onClose={() => setCreating(false)}>
          <form onSubmit={create} style={{ display: "grid", gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>A workspace holds projects and the people who work on them.</p>
            <input id="ws-name" className="input" autoFocus required maxLength={60} placeholder="e.g. Backend team" value={newName} onChange={(e) => setNewName(e.target.value)} />
            {error && <div className="err">{error}</div>}
            <button className="btn primary" type="submit" style={{ justifySelf: "start" }}>Create workspace</button>
          </form>
        </Dialog>
      )}
    </header>
  );
}
