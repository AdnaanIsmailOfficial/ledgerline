import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Opens (and if needed creates) a database and brings it up to the latest
 * schema. Pass ":memory:" for a throwaway database in tests.
 */
export function openDb(file: string) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  return db;
}

export type Db = ReturnType<typeof openDb>;

// Cached on globalThis so Next.js hot reloads reuse one connection per file.
const cache = globalThis as unknown as { __ledgerlineDb?: Map<string, Db> };

export function getDb(): Db {
  const file = path.resolve(getEnv().LEDGERLINE_DB_PATH);
  const open = (cache.__ledgerlineDb ??= new Map());
  let db = open.get(file);
  if (!db) {
    db = openDb(file);
    open.set(file, db);
  }
  return db;
}
