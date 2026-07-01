import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlite } from "../db/client.ts";
import { config } from "../config.ts";

const SNAPSHOT_PREFIX = "app-";
const SNAPSHOT_SUFFIX = ".sqlite";
const KEEP_SNAPSHOTS = 14;
const STATUS_FILE = "last-backup.json";

/** Consistent online backup via better-sqlite3's native `.backup()` — safe to
 * run against a live WAL-mode database, no downtime. Runs automatically once
 * a day from inside the app process (see index.ts) so there's nothing extra
 * for the operator to configure — this covers the database only (galleries,
 * photo metadata, and — critically — the favorites picks, which have no
 * other copy anywhere). Photo files themselves are NOT included here; back
 * up the whole `./data` directory with your own tool for full disaster
 * recovery (see the README). */
export async function runDatabaseBackup(): Promise<void> {
  await mkdir(config.backupsDir, { recursive: true });

  const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const destination = join(config.backupsDir, `${SNAPSHOT_PREFIX}${dateStamp}${SNAPSHOT_SUFFIX}`);

  await sqlite.backup(destination);
  await writeFile(
    join(config.backupsDir, STATUS_FILE),
    JSON.stringify({ lastBackupAt: new Date().toISOString() }),
  );

  await pruneOldSnapshots();
}

async function pruneOldSnapshots(): Promise<void> {
  const files = await readdir(config.backupsDir).catch(() => []);
  const snapshots = files
    .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(SNAPSHOT_SUFFIX))
    .sort(); // filenames are YYYY-MM-DD, so lexical sort is chronological

  const toDelete = snapshots.slice(0, Math.max(0, snapshots.length - KEEP_SNAPSHOTS));
  await Promise.all(toDelete.map((f) => rm(join(config.backupsDir, f), { force: true })));
}

export async function getLastBackupStatus(): Promise<{ lastBackupAt: string | null; isStale: boolean }> {
  const STALE_AFTER_MS = 36 * 60 * 60 * 1000; // a bit over one missed daily cycle
  try {
    const raw = await readFile(join(config.backupsDir, STATUS_FILE), "utf-8");
    const parsed = JSON.parse(raw) as { lastBackupAt: string };
    const isStale = Date.now() - new Date(parsed.lastBackupAt).getTime() > STALE_AFTER_MS;
    return { lastBackupAt: parsed.lastBackupAt, isStale };
  } catch {
    return { lastBackupAt: null, isStale: true };
  }
}
