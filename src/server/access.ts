import { and, eq } from "drizzle-orm";
import type { Role } from "../shared/protocol";
import type { DB } from "./db";
import { project, projectGuest, workspace, workspaceMember } from "./db/app-schema";

export async function workspaceRole(db: DB, workspaceId: string, userId: string): Promise<Role | null> {
  const row = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .get();
  return row?.role ?? null;
}

export interface ProjectAccess {
  project: typeof project.$inferSelect;
  workspaceName: string;
  role: Role;
  guest: boolean;
}

export async function projectAccess(db: DB, projectId: string, userId: string): Promise<ProjectAccess | null> {
  const row = await db
    .select({ p: project, wsName: workspace.name })
    .from(project)
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(project.id, projectId))
    .get();
  if (!row) return null;
  const wsRole = await workspaceRole(db, row.p.workspaceId, userId);
  const g = await db
    .select({ role: projectGuest.role })
    .from(projectGuest)
    .where(and(eq(projectGuest.projectId, projectId), eq(projectGuest.userId, userId)))
    .get();
  // Someone can be both a workspace viewer and an editor guest on one project; the higher role wins.
  if (wsRole && (!g || RANK[wsRole] >= RANK[g.role])) return { project: row.p, workspaceName: row.wsName, role: wsRole, guest: false };
  if (g) return { project: row.p, workspaceName: row.wsName, role: g.role, guest: !wsRole };
  return null;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export const atLeast = (role: Role | null | undefined, min: Role) => !!role && RANK[role] >= RANK[min];
