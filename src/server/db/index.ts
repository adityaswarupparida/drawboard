import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as appSchema from "./app-schema";
import * as authSchema from "./auth-schema";

export const schema = { ...authSchema, ...appSchema };

export function getDb(env: Pick<Env, "DB">) {
  return drizzle(env.DB, { schema });
}
export type DB = ReturnType<typeof getDb>;
