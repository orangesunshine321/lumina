import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

mkdirSync(dirname(config.databasePath), { recursive: true });
mkdirSync(config.backupsDir, { recursive: true });

export const sqlite = new Database(config.databasePath);
sqlite.pragma("journal_mode = WAL");
// The recommended pairing with WAL: still crash-safe (the WAL is synced at
// checkpoint), skips the per-commit fsync that FULL pays — meaningful once
// every upload/favorite/session write goes through here.
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });
export { schema };
