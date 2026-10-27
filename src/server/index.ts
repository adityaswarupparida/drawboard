import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { projectAccess } from "./access";
import { createAuth, enabledProviders } from "./auth";
import { getDb } from "./db";
import type { AppEnv } from "./env";
import { api } from "./routes";

export { CanvasAgent } from "./canvas-agent";
export { DesignReviewWorkflow } from "./review-workflow";

const app = new Hono<AppEnv>();

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env, c.req.url).handler(c.req.raw));

app.get("/api/config", (c) => c.json({ providers: enabledProviders(c.env) }));

// Order matters: the two routes above respond before this session lookup runs.
app.use("/api/*", async (c, next) => {
  const session = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  await next();
});

app.route("/api", api);

// The agent trusts these x-* identity headers because we overwrite whatever the browser sent.
app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env, {
    onBeforeConnect: async (req, { name }) => {
      const session = await createAuth(c.env, c.req.url).api.getSession({ headers: req.headers });
      if (!session) return new Response("Please sign in", { status: 401 });
      const access = await projectAccess(getDb(c.env), name, session.user.id);
      if (!access) return new Response("No access to this project", { status: 403 });
      const headers = new Headers(req.headers);
      headers.set("x-user-id", session.user.id);
      headers.set("x-user-name", encodeURIComponent(session.user.name || session.user.email));
      headers.set("x-role", access.role);
      return new Request(req, { headers });
    },
    // WebSocket only; no plain HTTP access to the agent.
    onBeforeRequest: () => new Response("Not found", { status: 404 }),
  });
  return res ?? c.json({ error: "Not found" }, 404);
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default app;
