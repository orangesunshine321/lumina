import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { getLastBackupStatus } from "../../services/backup.ts";
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
