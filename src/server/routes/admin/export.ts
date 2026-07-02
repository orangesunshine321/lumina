import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { streamGalleryZip } from "../../services/zip.ts";

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

  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    "/api/admin/galleries/:id/download",
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const scope = request.query.scope ?? "all";
      if (scope !== "all" && scope !== "favorites") {
        return reply.code(400).send({ error: "invalid_scope" });
      }

      const streamed = await streamGalleryZip(request, reply, gallery, scope);
      if (!streamed) {
        return reply.code(400).send({ error: scope === "favorites" ? "no_favorites" : "no_photos" });
      }
    },
  );
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}
