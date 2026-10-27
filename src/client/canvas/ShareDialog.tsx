import { useState } from "react";
import { Link } from "react-router";
import type { ProjectDetail, Role } from "../../shared/protocol";
import { api } from "../api";
import { Avatar, CopyLink, Dialog, RoleBadge } from "../components/ui";

export function ShareDialog({ project, onClose, onChanged }: { project: ProjectDetail; onClose: () => void; onChanged: () => void }) {
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = !project.guestRole && project.role !== "viewer";

  const create = async () => {
    setError(null);
    try {
      const r = await api.createInvite({ workspaceId: project.workspaceId, projectId: project.id, role });
      setLink(r.url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title={`Share “${project.name}”`} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>
        Everyone in the <b>{project.workspaceName}</b> workspace can open this project with their workspace role.
        {manage && (
          <>
            {" "}
            <Link to={`/w/${project.workspaceId}/settings`}>Manage workspace members</Link>
          </>
        )}
      </p>

      {manage ? (
        <div style={{ display: "grid", gap: 8 }}>
          <span className="label">Invite someone to this project only</span>
          <div className="row">
            <select id="share-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
            <button className="btn primary" type="button" onClick={create}>Create link</button>
          </div>
          {link && <CopyLink url={link} />}
          {link && <span className="muted" style={{ fontSize: "0.8rem" }}>The link works for 7 days. Guests only see this project, not the rest of the workspace.</span>}
          {error && <div className="err">{error}</div>}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Only workspace editors and owners can invite people.</p>
      )}

      {project.guests.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <span className="label">Guests</span>
          {project.guests.map((g) => (
            <div className="row" key={g.userId}>
              <Avatar id={g.userId} name={g.name} image={g.image} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{g.name}</div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>{g.email}</div>
              </div>
              <RoleBadge role={g.role} />
              {manage && (
                <button
                  className="btn small danger"
                  type="button"
                  onClick={async () => {
                    await api.removeGuest(project.id, g.userId).catch((e: Error) => setError(e.message));
                    onChanged();
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
