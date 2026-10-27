import type { CanvasAgent } from "./canvas-agent";

export interface Env {
  DB: D1Database;
  AI: Ai;
  CanvasAgent: DurableObjectNamespace<CanvasAgent>;
  DESIGN_REVIEW: Workflow;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser | null };
};
