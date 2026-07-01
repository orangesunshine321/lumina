import { ZipArchive } from "archiver";
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { originalPath } from "../../lib/storage.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";

type DownloadScope = "all" | "favorites";

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

      const scopeParam = request.query.scope ?? "all";
      if (scopeParam !== "all" && scopeParam !== "favorites") {
        return reply.code(400).send({ error: "invalid_scope" });
      }
      const scope: DownloadScope = scopeParam;

      const photos =
        scope === "all"
          ? await db
              .select()
              .from(schema.photos)
              .where(and(eq(schema.photos.galleryId, gallery.id), eq(schema.photos.status, "ready")))
              .orderBy(asc(schema.photos.sortIndex))
          : await db
              .select({
                id: schema.photos.id,
                galleryId: schema.photos.galleryId,
                fileExt: schema.photos.fileExt,
                originalFilename: schema.photos.originalFilename,
              })
              .from(schema.favorites)
              .innerJoin(
                schema.photos,
                and(eq(schema.favorites.photoId, schema.photos.id), eq(schema.photos.status, "ready")),
              )
              .where(eq(schema.favorites.galleryId, gallery.id))
              .orderBy(asc(schema.photos.sortIndex));

      if (scope === "favorites" && photos.length === 0) {
        return reply.code(400).send({ error: "no_favorites" });
      }

      const filename = `${slugify(gallery.title)}-${scope}.zip`;

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });

      // Source files are already-compressed JPEGs — skip re-compression to
      // save CPU, `store: true` writes them into the zip verbatim.
      const archive = new ZipArchive({ store: true });
      archive.on("error", (err: Error) => {
        request.log.error({ err, galleryId: gallery.id }, "zip archive error");
        reply.raw.destroy(err);
      });
      archive.pipe(reply.raw);

      // Different photos can share an original filename (same camera, two
      // cards); identical zip entry names would silently overwrite on extract.
      const usedNames = new Set<string>();
      for (const photo of photos) {
        archive.file(originalPath(photo.galleryId, photo.id, photo.fileExt), {
          name: uniqueEntryName(photo.originalFilename, usedNames),
        });
      }

      await archive.finalize();
    },
  );
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}

function uniqueEntryName(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot > 0 ? filename.slice(lastDot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "gallery";
}
