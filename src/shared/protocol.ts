import type { Annotation, AuthorRef, Diagram, Op, Severity } from "./diagram";

export type Role = "owner" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "editor", "viewer"];
export const canEdit = (r: Role | null | undefined) => r === "owner" || r === "editor";

/* ---------------- Agent state (synced to every client) ---------------- */

export interface ReviewStatus {
  status: "idle" | "running";
  step?: string;
  stepIndex?: number;
  startedBy?: string;
}

export interface CanvasState {
  diagram: Diagram;
  /** Notes pinned to boxes by the design review. */
  annotations: Annotation[];
  /** Boxes the AI highlighted while answering a question. */
  highlights: Record<string, Severity>;
  review: ReviewStatus;
  /** Who the AI is currently working for, if anyone. */
  aiBusy: { for: string } | null;
  version: number;
  /** What Undo would roll back, if anything. */
  undo: { summary: string; by: string } | null;
}

export const REVIEW_STEPS = ["Reliability", "Scaling", "Security", "Cost"] as const;

/* ---------------- Chat + history ---------------- */

export interface Finding {
  nodeId: string;
  nodeLabel: string;
  severity: Exclude<Severity, "ok">;
  title: string;
  detail: string;
  area: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "ai" | "system";
  author: AuthorRef;
  text: string;
  /** Edits the AI made, as readable lines. */
  ops?: string[];
  findings?: Finding[];
  status?: "thinking" | "done" | "error";
  /** What the AI is doing right now, shown while status is "thinking". */
  phase?: string;
  /** Extra context for a user message, e.g. which boxes were selected. */
  context?: string;
  meta?: string;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  at: number;
  by: AuthorRef;
  summary: string;
}

export interface Presence {
  connectionId: string;
  userId: string;
  name: string;
  color: string;
  role: Role;
}

/* ---------------- WebSocket messages ---------------- */

export type ClientMessage =
  | { type: "ops"; ops: Op[] }
  | { type: "chat"; text: string; selection?: string[] }
  | { type: "cursor"; x: number; y: number }
  | { type: "cursor_leave" }
  | { type: "drag"; id: string; x: number; y: number }
  | { type: "undo" }
  | { type: "review" }
  | { type: "tidy" };

export type ServerMessage =
  | {
      type: "hello";
      you: Presence;
      chat: ChatMessage[];
      history: HistoryEntry[];
    }
  | { type: "chat_upsert"; message: ChatMessage }
  | { type: "history"; entry: HistoryEntry }
  | { type: "presence"; users: Presence[] }
  | { type: "cursor"; connectionId: string; x: number; y: number }
  | { type: "cursor_leave"; connectionId: string }
  | { type: "drag"; connectionId: string; id: string; x: number; y: number }
  | { type: "error"; message: string };

/* ---------------- REST API types ---------------- */

export interface WorkspaceSummary {
  id: string;
  name: string;
  personal: boolean;
  role: Role;
  projectCount: number;
  memberCount: number;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: string;
  updatedAt: number;
  /** Set when the user reaches this project as a guest rather than a workspace member. */
  guestRole?: Role;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
}

export interface InviteInfo {
  token: string;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  invitedBy: string;
  expiresAt: number;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  projects: ProjectSummary[];
  members: Member[];
}

export interface ProjectDetail extends ProjectSummary {
  workspaceName: string;
  role: Role;
  guests: Member[];
}

const PALETTE = ["#2d58cf", "#c2541a", "#7a4fd1", "#1f8a5b", "#b8336a", "#9a6b00", "#0f7c9c", "#5b6b00"];
export function colorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
export const AI_AUTHOR: AuthorRef = { id: "ai", name: "Drawboard AI", ai: true };
