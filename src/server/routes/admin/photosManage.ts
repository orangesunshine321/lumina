import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { originalPath, photoDerivedDir } from "../../lib/storage.ts";

export async function photoManageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  /** Bulk delete (a single id is just a one-element batch). Favorites cascade
   * via FK; coverPhotoId is SET NULL by its FK and then reassigned below. */
  app.post<{ Params: { id: string }; Body: { photoIds: string[] } }>(
    "/api/admin/galleries/:id/photos/delete",
    {
      schema: {
        body: {
          type: "object",
          required: ["photoIds"],
          properties: {
            photoIds: {
              type: "array",
              minItems: 1,
              maxItems: 500,
              items: { type: "string", maxLength: 64 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: galleryId } = request.params;
      const gallery = await findGallery(galleryId);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      // Only rows that actually belong to this gallery — ids for other
      // galleries' photos are silently ignored rather than deleted.
      const targets = await db
        .select({ id: schema.photos.id, fileExt: schema.photos.fileExt })
        .from(schema.photos)
        .where(
          and(eq(schema.photos.galleryId, galleryId), inArray(schema.photos.id, request.body.photoIds)),
        );
      if (targets.length === 0) return { deleted: 0 };

      await db.delete(schema.photos).where(
        inArray(
          schema.photos.id,
          targets.map((t) => t.id),
        ),
      );

      // Recount from the source of truth instead of decrementing — self-heals
      // any historical drift, and reassign a cover if the old one was deleted.
      const [counts] = await db
        .select({ total: sql<number>`count(*)` })
        .from(schema.photos)
        .where(eq(schema.photos.galleryId, galleryId));
      const [nextCover] = await db
        .select({ id: schema.photos.id })
        .from(schema.photos)
        .where(and(eq(schema.photos.galleryId, galleryId), eq(schema.photos.status, "ready")))
        .orderBy(asc(schema.photos.sortIndex))
        .limit(1);

      const [refreshed] = await db
        .select({ coverPhotoId: schema.galleries.coverPhotoId })
        .from(schema.galleries)
        .where(eq(schema.galleries.id, galleryId));
      await db
        .update(schema.galleries)
        .set({
          photoCount: counts?.total ?? 0,
          coverPhotoId: refreshed?.coverPhotoId ?? nextCover?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.galleries.id, galleryId));

      // Disk cleanup is best-effort and after the DB commit — a leftover file
      // is harmless (unreferenced), a dangling DB row is not.
      await Promise.all(
        targets.map(async (t) => {
          await rm(originalPath(galleryId, t.id, t.fileExt), { force: true }).catch(() => {});
          await rm(photoDerivedDir(galleryId, t.id), { recursive: true, force: true }).catch(() => {});
        }),
      );

      return { deleted: targets.length };
    },
  );

  /** Requeues a photo whose processing permanently failed. */
  app.post<{ Params: { id: string; photoId: string } }>(
    "/api/admin/galleries/:id/photos/:photoId/retry",
    async (request, reply) => {
      const { id: galleryId, photoId } = request.params;
      const [updated] = await db
        .update(schema.photos)
        .set({ status: "pending", attempts: 0, lastError: null })
        .where(
          and(
            eq(schema.photos.id, photoId),
            eq(schema.photos.galleryId, galleryId),
            eq(schema.photos.status, "failed"),
          ),
        )
        .returning({ id: schema.photos.id });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}
