import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
const unconfiguredUrl = "postgresql://unconfigured:unconfigured@127.0.0.1:5432/unconfigured";

const globalForDb = globalThis as unknown as { canvasGroveSql?: ReturnType<typeof postgres> };
const client = globalForDb.canvasGroveSql ?? postgres(databaseUrl ?? unconfiguredUrl, { max: process.env.NODE_ENV === "production" ? 10 : 1 });

if (process.env.NODE_ENV !== "production") globalForDb.canvasGroveSql = client;

export const db = drizzle(client, { schema });
export type Database = typeof db;

/** Raw postgres.js tenant transaction, for SQL shared verbatim with the sync worker. */
export async function withTenantSql<T>(ownerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for persistent storage");
  return client.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${ownerId}, true)`;
    return work(tx);
  }) as Promise<T>;
}

export async function withTenantTransaction<T>(ownerId: string, work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for persistent storage");
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select set_config('app.user_id', ${ownerId}, true)`);
    return work(tx);
  });
}
