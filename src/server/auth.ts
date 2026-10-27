import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { workspace } from "./db/app-schema";
import * as authSchema from "./db/auth-schema";
import type { Env } from "./env";
import { createPersonalWorkspace } from "./routes";

export function enabledProviders(env: Env) {
  return {
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}

/** Better Auth reads config per request because Worker env is only available at request time. */
export function createAuth(env: Env, requestUrl: string) {
  const db = getDb(env);
  const origin = env.BETTER_AUTH_URL || new URL(requestUrl).origin;
  const providers = enabledProviders(env);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    socialProviders: {
      ...(providers.github ? { github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! } } : {}),
      ...(providers.google ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } } : {}),
    },
    databaseHooks: {
      user: {
        create: {
          // Every new account gets a personal workspace.
          after: async (u) => {
            const existing = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.createdBy, u.id)).get();
            if (!existing) await createPersonalWorkspace(db, u.id, u.name || "My");
          },
        },
      },
    },
  });
}
