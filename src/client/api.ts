import type {
  InviteInfo,
  ProjectDetail,
  ProjectSummary,
  Role,
  WorkspaceDetail,
  WorkspaceSummary,
} from "../shared/protocol";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  workspaces: () => call<WorkspaceSummary[]>("GET", "/workspaces"),
  createWorkspace: (name: string) => call<WorkspaceSummary>("POST", "/workspaces", { name }),
  workspace: (id: string) => call<WorkspaceDetail>("GET", `/workspaces/${id}`),
  renameWorkspace: (id: string, name: string) => call<void>("PATCH", `/workspaces/${id}`, { name }),
  deleteWorkspace: (id: string) => call<void>("DELETE", `/workspaces/${id}`),
  setMemberRole: (id: string, userId: string, role: Role) => call<void>("PATCH", `/workspaces/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => call<void>("DELETE", `/workspaces/${id}/members/${userId}`),
  leaveWorkspace: (id: string) => call<void>("POST", `/workspaces/${id}/leave`),

  createProject: (workspaceId: string, name: string, description?: string) =>
    call<ProjectSummary>("POST", "/projects", { workspaceId, name, description }),
  project: (id: string) => call<ProjectDetail>("GET", `/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; description?: string }) => call<void>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: string) => call<void>("DELETE", `/projects/${id}`),
  removeGuest: (id: string, userId: string) => call<void>("DELETE", `/projects/${id}/guests/${userId}`),
  sharedWithMe: () => call<ProjectSummary[]>("GET", "/projects/shared"),

  createInvite: (body: { workspaceId: string; projectId?: string; role: Role }) =>
    call<{ token: string; url: string; expiresAt: number }>("POST", "/invites", body),
  invite: (token: string) => call<InviteInfo>("GET", `/invites/${token}`),
  acceptInvite: (token: string) => call<{ workspaceId: string; projectId: string | null }>("POST", `/invites/${token}/accept`),

  transcribe: async (projectId: string, audio: Blob): Promise<string> => {
    const res = await fetch(`/api/projects/${projectId}/transcribe`, { method: "POST", body: audio, credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "Could not transcribe audio");
    return ((await res.json()) as { text: string }).text;
  },
};
