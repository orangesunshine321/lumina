import { createReadStream, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { getLastBackupStatus, runDatabaseBackup } from "../../services/backup.ts";
import { config } from "../../config.ts";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/admin/backup-status", { preHandler: requireAdmin }, async () => {
    return getLastBackupStatus();
  });

  /** On-demand snapshot — same consistent online backup the daily sweep runs. */
  app.post("/api/admin/backup/run", { preHandler: requireAdmin }, async () => {
    await runDatabaseBackup();
    return getLastBackupStatus();
  });

  /** Streams the newest snapshot so off-box backup is one click, no CLI.
   * (Photo files still need a filesystem-level backup — documented in the
   * README — but the DB is the part with no other copy anywhere.) */
  app.get("/api/admin/backup/download", { preHandler: requireAdmin }, async (request, reply) => {
    const files = (await readdir(config.backupsDir).catch(() => []))
      .filter((f) => f.startsWith("app-") && f.endsWith(".sqlite"))
      .sort(); // YYYY-MM-DD names — lexical sort is chronological
    const latest = files[files.length - 1];
    if (!latest) return reply.code(404).send({ error: "no_backup_yet" });

    const path = join(config.backupsDir, latest);
    const info = await stat(path);
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="pixset-${latest}"`);
    reply.header("Content-Length", info.size);
    return reply.send(createReadStream(path));
  });

  /** One-call health/inventory snapshot for the admin dashboard. Sizes come
   * from the DB (SUM of stored byte sizes), not a filesystem walk — a walk
   * over tens of thousands of photos on NAS spinning disks is too slow for a
   * dashboard request. */
  app.get("/api/admin/system", { preHandler: requireAdmin }, async () => {
    const backup = await getLastBackupStatus();
    const dbSize = await stat(config.databasePath).then(
      (s) => s.size,
      () => 0,
    );

    const [library] = await db
      .select({
        photos: sql<number>`count(*)`,
        originalsBytes: sql<number>`coalesce(sum(${schema.photos.byteSize}), 0)`,
      })
      .from(schema.photos);
    const [galleryCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.galleries);

    const queueRows = await db
      .select({ status: schema.photos.status, count: sql<number>`count(*)` })
      .from(schema.photos)
      .groupBy(schema.photos.status);
    const queue = { pending: 0, processing: 0, failed: 0 };
    for (const row of queueRows) {
      if (row.status === "pending") queue.pending = row.count;
      if (row.status === "processing") queue.processing = row.count;
      if (row.status === "failed") queue.failed = row.count;
    }

    return {
      version: VERSION,
      backup,
      database: { sizeBytes: dbSize },
      library: {
        galleries: galleryCount?.count ?? 0,
        photos: library?.photos ?? 0,
        originalsBytes: library?.originalsBytes ?? 0,
      },
      queue,
    };
  });
}
