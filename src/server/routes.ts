import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  InviteInfo,
  Member,
  ProjectDetail,
  ProjectSummary,
  Role,
  WorkspaceDetail,
  WorkspaceSummary,
} from "../shared/protocol";
import { atLeast, projectAccess, workspaceRole } from "./access";
import { transcribe } from "./ai";
import { getDb, type DB } from "./db";
import { invite, project, projectGuest, workspace, workspaceMember } from "./db/app-schema";
import { user } from "./db/auth-schema";
import type { AppEnv } from "./env";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const roleSchema = z.enum(["owner", "editor", "viewer"]);
const nameSchema = z.string().trim().min(1).max(60);

export const api = new Hono<AppEnv>();

// Every API route needs a signed-in user.
api.use("*", async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Please sign in" }, 401);
  await next();
});

const bad = (msg: string) => ({ error: msg });

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | null> {
  try {
    const r = schema.safeParse(await req.json());
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function toProject(p: typeof project.$inferSelect, guestRole?: Role): ProjectSummary {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    description: p.description,
    createdBy: p.createdBy,
    updatedAt: p.updatedAt,
    ...(guestRole ? { guestRole } : {}),
  };
}

export async function createPersonalWorkspace(db: DB, userId: string, name: string) {
  const id = nanoid(12);
  const now = Date.now();
  await db.batch([
    db.insert(workspace).values({ id, name: `${name.split(" ")[0] || "My"}'s workspace`, personal: true, createdBy: userId, createdAt: now }),
    db.insert(workspaceMember).values({ workspaceId: id, userId, role: "owner", createdAt: now }),
  ]);
  return id;
}

/* ---------------- workspaces ---------------- */

api.get("/workspaces", async (c) => {
  const db = getDb(c.env);
  const me = c.get("user")!;
  const rows = await db
    .select({ w: workspace, role: workspaceMember.role })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(eq(workspaceMember.userId, me.id))
    .orderBy(desc(workspace.personal), workspace.createdAt)
    .all();
  if (!rows.length) {
    // Safety net: everyone should have a personal workspace.
    await createPersonalWorkspace(db, me.id, me.name);
    return c.redirect("/api/workspaces");
  }
  const ids = rows.map((r) => r.w.id);
  const pc = await db.select({ id: project.workspaceId, n: count() }).from(project).where(inArray(project.workspaceId, ids)).groupBy(project.workspaceId).all();
  const mc = await db.select({ id: workspaceMember.workspaceId, n: count() }).from(workspaceMember).where(inArray(workspaceMember.workspaceId, ids)).groupBy(workspaceMember.workspaceId).all();
  const out: WorkspaceSummary[] = rows.map((r) => ({
    id: r.w.id,
    name: r.w.name,
    personal: r.w.personal,
    role: r.role,
    projectCount: pc.find((x) => x.id === r.w.id)?.n ?? 0,
    memberCount: mc.find((x) => x.id === r.w.id)?.n ?? 0,
  }));
  return c.json(out);
});

api.post("/workspaces", async (c) => {
  const b = await body(c.req.raw, z.object({ name: nameSchema }));
  if (!b) return c.json(bad("Give the workspace a name (up to 60 characters)."), 400);
  const db = getDb(c.env);
  const me = c.get("user")!;
  const id = nanoid(12);
  const now = Date.now();
  await db.batch([
    db.insert(workspace).values({ id, name: b.name, personal: false, createdBy: me.id, createdAt: now }),
    db.insert(workspaceMember).values({ workspaceId: id, userId: me.id, role: "owner", createdAt: now }),
  ]);
  const out: WorkspaceSummary = { id, name: b.name, personal: false, role: "owner", projectCount: 0, memberCount: 1 };
  return c.json(out, 201);
});

api.get("/workspaces/:id", async (c) => {
  const db = getDb(c.env);
  const me = c.get("user")!;
  const id = c.req.param("id");
  const role = await workspaceRole(db, id, me.id);
  if (!role) return c.json(bad("You don't have access to this workspace."), 404);
  const w = await db.select().from(workspace).where(eq(workspace.id, id)).get();
  if (!w) return c.json(bad("Workspace not found."), 404);
  const projects = await db.select().from(project).where(eq(project.workspaceId, id)).orderBy(desc(project.updatedAt)).all();
  const members = await db
    .select({ userId: user.id, name: user.name, email: user.email, image: user.image, role: workspaceMember.role })
    .from(workspaceMember)
    .innerJoin(user, eq(user.id, workspaceMember.userId))
    .where(eq(workspaceMember.workspaceId, id))
    .orderBy(workspaceMember.createdAt)
    .all();
  const out: WorkspaceDetail = {
    id: w.id,
    name: w.name,
    personal: w.personal,
    role,
    projectCount: projects.length,
    memberCount: members.length,
    projects: projects.map((p) => toProject(p)),
    members: members as Member[],
  };
  return c.json(out);
});

api.patch("/workspaces/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  if (!atLeast(await workspaceRole(db, id, c.get("user")!.id), "owner")) return c.json(bad("Only owners can rename a workspace."), 403);
  const b = await body(c.req.raw, z.object({ name: nameSchema }));
  if (!b) return c.json(bad("Give the workspace a name (up to 60 characters)."), 400);
  await db.update(workspace).set({ name: b.name }).where(eq(workspace.id, id));
  return c.body(null, 204);
});

api.delete("/workspaces/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  if (!atLeast(await workspaceRole(db, id, c.get("user")!.id), "owner")) return c.json(bad("Only owners can delete a workspace."), 403);
  const w = await db.select().from(workspace).where(eq(workspace.id, id)).get();
  if (w?.personal) return c.json(bad("Your personal workspace can't be deleted."), 400);
  await db.delete(workspace).where(eq(workspace.id, id));
  return c.body(null, 204);
});

async function ownerCount(db: DB, id: string) {
  const r = await db.select({ n: count() }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, id), eq(workspaceMember.role, "owner"))).get();
  return r?.n ?? 0;
}

api.patch("/workspaces/:id/members/:userId", async (c) => {
  const db = getDb(c.env);
  const { id, userId } = c.req.param();
  if (!atLeast(await workspaceRole(db, id, c.get("user")!.id), "owner")) return c.json(bad("Only owners can change roles."), 403);
  const b = await body(c.req.raw, z.object({ role: roleSchema }));
  if (!b) return c.json(bad("Unknown role."), 400);
  const current = await workspaceRole(db, id, userId);
  if (!current) return c.json(bad("That person isn't in this workspace."), 404);
  if (current === "owner" && b.role !== "owner" && (await ownerCount(db, id)) <= 1)
    return c.json(bad("A workspace needs at least one owner. Make someone else an owner first."), 400);
  await db.update(workspaceMember).set({ role: b.role }).where(and(eq(workspaceMember.workspaceId, id), eq(workspaceMember.userId, userId)));
  return c.body(null, 204);
});

api.delete("/workspaces/:id/members/:userId", async (c) => {
  const db = getDb(c.env);
  const { id, userId } = c.req.param();
  if (!atLeast(await workspaceRole(db, id, c.get("user")!.id), "owner")) return c.json(bad("Only owners can remove people."), 403);
  if ((await workspaceRole(db, id, userId)) === "owner" && (await ownerCount(db, id)) <= 1)
    return c.json(bad("You can't remove the last owner."), 400);
  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, id), eq(workspaceMember.userId, userId)));
  return c.body(null, 204);
});

api.post("/workspaces/:id/leave", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const me = c.get("user")!.id;
  const role = await workspaceRole(db, id, me);
  if (!role) return c.json(bad("You're not in this workspace."), 404);
  const w = await db.select().from(workspace).where(eq(workspace.id, id)).get();
  if (w?.personal) return c.json(bad("You can't leave your personal workspace."), 400);
  if (role === "owner" && (await ownerCount(db, id)) <= 1) return c.json(bad("You're the only owner. Make someone else an owner first."), 400);
  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, id), eq(workspaceMember.userId, me)));
  return c.body(null, 204);
});

/* ---------------- projects ---------------- */

api.get("/projects/shared", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ p: project, role: projectGuest.role })
    .from(projectGuest)
    .innerJoin(project, eq(project.id, projectGuest.projectId))
    .where(eq(projectGuest.userId, c.get("user")!.id))
    .orderBy(desc(project.updatedAt))
    .all();
  return c.json(rows.map((r) => toProject(r.p, r.role)));
});

api.post("/projects", async (c) => {
  const db = getDb(c.env);
  const me = c.get("user")!;
  const b = await body(c.req.raw, z.object({ workspaceId: z.string(), name: nameSchema, description: z.string().trim().max(280).optional() }));
  if (!b) return c.json(bad("Give the project a name (up to 60 characters)."), 400);
  if (!atLeast(await workspaceRole(db, b.workspaceId, me.id), "editor")) return c.json(bad("Viewers can't create projects."), 403);
  const now = Date.now();
  const row = { id: nanoid(12), workspaceId: b.workspaceId, name: b.name, description: b.description || null, createdBy: me.id, createdAt: now, updatedAt: now };
  await db.insert(project).values(row);
  return c.json(toProject(row), 201);
});

api.get("/projects/:id", async (c) => {
  const db = getDb(c.env);
  const acc = await projectAccess(db, c.req.param("id"), c.get("user")!.id);
  if (!acc) return c.json(bad("You don't have access to this project."), 404);
  const guests = await db
    .select({ userId: user.id, name: user.name, email: user.email, image: user.image, role: projectGuest.role })
    .from(projectGuest)
    .innerJoin(user, eq(user.id, projectGuest.userId))
    .where(eq(projectGuest.projectId, acc.project.id))
    .all();
  const out: ProjectDetail = {
    ...toProject(acc.project, acc.guest ? acc.role : undefined),
    workspaceName: acc.workspaceName,
    role: acc.role,
    guests: guests as Member[],
  };
  return c.json(out);
});

api.patch("/projects/:id", async (c) => {
  const db = getDb(c.env);
  const acc = await projectAccess(db, c.req.param("id"), c.get("user")!.id);
  if (!acc || !atLeast(acc.role, "editor")) return c.json(bad("You can't edit this project."), 403);
  const b = await body(c.req.raw, z.object({ name: nameSchema.optional(), description: z.string().trim().max(280).optional() }));
  if (!b) return c.json(bad("Invalid project details."), 400);
  await db.update(project).set({ ...b, updatedAt: Date.now() }).where(eq(project.id, acc.project.id));
  return c.body(null, 204);
});

api.delete("/projects/:id", async (c) => {
  const db = getDb(c.env);
  const acc = await projectAccess(db, c.req.param("id"), c.get("user")!.id);
  if (!acc || acc.guest || !atLeast(acc.role, "editor")) return c.json(bad("You can't delete this project."), 403);
  await db.delete(project).where(eq(project.id, acc.project.id));
  // Wipe the canvas storage too.
  const stub = c.env.CanvasAgent.get(c.env.CanvasAgent.idFromName(acc.project.id));
  await stub.destroyCanvas().catch(() => {});
  return c.body(null, 204);
});

api.delete("/projects/:id/guests/:userId", async (c) => {
  const db = getDb(c.env);
  const { id, userId } = c.req.param();
  const acc = await projectAccess(db, id, c.get("user")!.id);
  if (!acc || acc.guest || !atLeast(acc.role, "editor")) return c.json(bad("You can't manage guests here."), 403);
  await db.delete(projectGuest).where(and(eq(projectGuest.projectId, id), eq(projectGuest.userId, userId)));
  return c.body(null, 204);
});

api.post("/projects/:id/transcribe", async (c) => {
  const db = getDb(c.env);
  const acc = await projectAccess(db, c.req.param("id"), c.get("user")!.id);
  if (!acc || !atLeast(acc.role, "editor")) return c.json(bad("You can't talk to the AI in this project."), 403);
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json(bad("No audio received."), 400);
  if (audio.byteLength > 8 * 1024 * 1024) return c.json(bad("Recording is too long. Keep it under a minute."), 413);
  try {
    return c.json({ text: await transcribe(c.env.AI, audio) });
  } catch (e) {
    console.error("transcribe failed", e);
    return c.json(bad("Could not transcribe that recording."), 502);
  }
});

/* ---------------- invites ---------------- */

api.post("/invites", async (c) => {
  const db = getDb(c.env);
  const me = c.get("user")!;
  const b = await body(c.req.raw, z.object({ workspaceId: z.string(), projectId: z.string().optional(), role: roleSchema }));
  if (!b) return c.json(bad("Invalid invite."), 400);
  const wsRole = await workspaceRole(db, b.workspaceId, me.id);
  if (b.projectId) {
    const p = await db.select().from(project).where(eq(project.id, b.projectId)).get();
    if (!p || p.workspaceId !== b.workspaceId) return c.json(bad("Project not found."), 404);
    if (!atLeast(wsRole, "editor")) return c.json(bad("Only workspace editors can invite guests."), 403);
    if (b.role === "owner") return c.json(bad("Project guests can be editors or viewers."), 400);
  } else {
    if (!atLeast(wsRole, "editor")) return c.json(bad("Viewers can't invite people."), 403);
    if (b.role === "owner" && wsRole !== "owner") return c.json(bad("Only owners can invite other owners."), 403);
  }
  const token = nanoid(24);
  const now = Date.now();
  await db.insert(invite).values({ token, workspaceId: b.workspaceId, projectId: b.projectId ?? null, role: b.role, createdBy: me.id, createdAt: now, expiresAt: now + INVITE_TTL_MS });
  const origin = new URL(c.req.url).origin;
  return c.json({ token, url: `${origin}/invite/${token}`, expiresAt: now + INVITE_TTL_MS }, 201);
});

async function loadInvite(db: DB, token: string) {
  return db
    .select({ i: invite, wsName: workspace.name, pName: project.name, by: user.name })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .leftJoin(project, eq(project.id, invite.projectId))
    .innerJoin(user, eq(user.id, invite.createdBy))
    .where(eq(invite.token, token))
    .get();
}

api.get("/invites/:token", async (c) => {
  const row = await loadInvite(getDb(c.env), c.req.param("token"));
  if (!row || row.i.expiresAt < Date.now()) return c.json(bad("This invite link is invalid or has expired. Ask for a new one."), 404);
  const out: InviteInfo = {
    token: row.i.token,
    role: row.i.role,
    workspaceId: row.i.workspaceId,
    workspaceName: row.wsName,
    projectId: row.i.projectId,
    projectName: row.pName ?? null,
    invitedBy: row.by,
    expiresAt: row.i.expiresAt,
  };
  return c.json(out);
});

api.post("/invites/:token/accept", async (c) => {
  const db = getDb(c.env);
  const me = c.get("user")!;
  const row = await loadInvite(db, c.req.param("token"));
  if (!row || row.i.expiresAt < Date.now()) return c.json(bad("This invite link is invalid or has expired. Ask for a new one."), 404);
  const { i } = row;
  const now = Date.now();
  const existing = await workspaceRole(db, i.workspaceId, me.id);
  if (i.projectId) {
    // Workspace members already see every project, so only add a guest row for outsiders.
    if (!existing) {
      await db
        .insert(projectGuest)
        .values({ projectId: i.projectId, userId: me.id, role: i.role === "viewer" ? "viewer" : "editor", createdAt: now })
        .onConflictDoUpdate({ target: [projectGuest.projectId, projectGuest.userId], set: { role: i.role === "viewer" ? "viewer" : "editor" } });
    }
  } else if (!existing) {
    await db.insert(workspaceMember).values({ workspaceId: i.workspaceId, userId: me.id, role: i.role, createdAt: now });
  } else if (atLeast(i.role, existing) && i.role !== existing) {
    await db.update(workspaceMember).set({ role: i.role }).where(and(eq(workspaceMember.workspaceId, i.workspaceId), eq(workspaceMember.userId, me.id)));
  }
  await db.update(invite).set({ uses: i.uses + 1 }).where(eq(invite.token, i.token));
  return c.json({ workspaceId: i.workspaceId, projectId: i.projectId });
});
