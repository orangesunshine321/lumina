import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { getLastBackupStatus } from "../../services/backup.ts";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/admin/backup-status", { preHandler: requireAdmin }, async () => {
    return getLastBackupStatus();
  });
}
