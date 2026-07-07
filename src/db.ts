import { createClient } from "@libsql/client";
import { requireEnv } from "./env";

export const db = createClient({
  url: requireEnv("TURSO_DATABASE_URL"),
  authToken: requireEnv("TURSO_AUTH_TOKEN"),
});

/** Simple wrapper for executing queries to ensure consistency */
export async function query(sql: string, args: any[] = []) {
  return await db.execute({ sql, args });
}

/** Helper to get a single row */
export async function getOne(sql: string, args: any[] = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0];
}

/** Helper to execute a statement (INSERT, UPDATE, DELETE) */
export async function run(sql: string, args: any[] = []) {
  return await db.execute({ sql, args });
}
