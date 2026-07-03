import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { collectZipEntries, streamPhotoZip } from "../../services/zip.ts";

export async function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Params: { id: string } }>("/api/admin/galleries/:id/lightroom-list", async (request, reply) => {
    const gallery = await findGallery(request.params.id);
    if (!gallery) return reply.code(404).send({ error: "not_found" });

    const rows = await db
      .select({ baseFilename: schema.photos.baseFilename })
      .from(schema.favorites)
      .innerJoin(
        schema.photos,
        and(eq(schema.favorites.photoId, schema.photos.id), eq(schema.photos.status, "ready")),
      )
      .where(eq(schema.favorites.galleryId, gallery.id))
      .orderBy(asc(schema.photos.sortIndex));

    const filenames = rows.map((r) => r.baseFilename);
    return { count: filenames.length, filenames, text: filenames.join(", ") };
  });

  app.get<{ Params: { id: string }; Querystring: { scope?: string; setId?: string } }>(
    "/api/admin/galleries/:id/download",
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const scope = request.query.scope ?? "all";
      const requestedSetId = request.query.setId;

      let entries;
      let filenameBase: string;
      let emptyError: string;

      // Admin gets everything regardless of client visibility/download toggles.
      if (scope === "favorites") {
        entries = await collectZipEntries({ galleryId: gallery.id, scope: "favorites" });
        filenameBase = `${gallery.title}-favorites`;
        emptyError = "no_favorites";
      } else if (scope === "set") {
        if (!requestedSetId) return reply.code(400).send({ error: "invalid_scope" });
        if (requestedSetId === "ungrouped") {
          entries = await collectZipEntries({ galleryId: gallery.id, scope: "set", setId: "ungrouped" });
          filenameBase = gallery.title;
        } else {
          const [set] = await db
            .select()
            .from(schema.photoSets)
            .where(and(eq(schema.photoSets.id, requestedSetId), eq(schema.photoSets.galleryId, gallery.id)))
            .limit(1);
          if (!set) return reply.code(404).send({ error: "not_found" });
          entries = await collectZipEntries({ galleryId: gallery.id, scope: "set", setId: set.id });
          filenameBase = set.title;
        }
        emptyError = "no_photos";
      } else if (scope === "all") {
        entries = await collectZipEntries({ galleryId: gallery.id, scope: "all", folderBySet: true });
        filenameBase = gallery.title;
        emptyError = "no_photos";
      } else {
        return reply.code(400).send({ error: "invalid_scope" });
      }

      const streamed = await streamPhotoZip(request, reply, filenameBase, entries);
      if (!streamed) {
        return reply.code(400).send({ error: emptyError });
      }
    },
  );
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}
