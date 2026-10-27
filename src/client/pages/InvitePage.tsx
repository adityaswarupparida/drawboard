import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { InviteInfo } from "../../shared/protocol";
import { api } from "../api";
import { useUser } from "../components/RequireAuth";
import { Logo } from "../icons";

export function InvitePage() {
  const { token = "" } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invite(token).then(setInfo).catch((e: Error) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      const r = await api.acceptInvite(token);
      navigate(r.projectId ? `/p/${r.projectId}` : `/w/${r.workspaceId}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card auth">
        <div className="brand"><Logo /><b>Drawboard</b></div>
        {error && (
          <>
            <div className="err">{error}</div>
            <Link className="btn" to="/">Go to your workspace</Link>
          </>
        )}
        {!error && !info && <div className="muted">Checking your invite…</div>}
        {info && !error && (
          <>
            <h1 style={{ fontSize: "1.4rem" }}>
              {info.projectName ? `Join the project “${info.projectName}”` : `Join “${info.workspaceName}”`}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {info.invitedBy} invited you as {info.role === "viewer" ? "a viewer" : info.role === "owner" ? "an owner" : "an editor"}
              {info.projectName ? ` in the ${info.workspaceName} workspace` : ""}. You're signed in as {user.email}.
            </p>
            <button className="btn primary" type="button" disabled={busy} onClick={accept} style={{ justifyContent: "center", padding: "9px 12px" }}>
              {busy ? "Joining…" : "Accept invite"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
