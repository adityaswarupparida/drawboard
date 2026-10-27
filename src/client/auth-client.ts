import { createAuthClient } from "better-auth/react";

// Same origin as the app, so no baseURL is needed.
export const authClient = createAuthClient();

export type SessionUser = { id: string; name: string; email: string; image?: string | null };
