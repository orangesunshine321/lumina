import { ZipArchive } from "archiver";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { originalPath } from "../lib/storage.ts";
import type { GalleryRow } from "../types.ts";

export type DownloadScope = "all" | "favorites";

/** Streams a zip of a gallery's original files. Shared by the admin download
 * route and the (opt-in) client-facing one — one code path, one auth story
 * per caller. Returns false when scope=favorites has nothing to include, so
 * the caller can send a friendly error instead of an empty archive. */
export async function streamGalleryZip(
  request: FastifyRequest,
  reply: FastifyReply,
  gallery: GalleryRow,
  scope: DownloadScope,
): Promise<boolean> {
  const photos =
    scope === "all"
      ? await db
          .select({
            id: schema.photos.id,
            galleryId: schema.photos.galleryId,
            fileExt: schema.photos.fileExt,
            originalFilename: schema.photos.originalFilename,
          })
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

  if (photos.length === 0) return false;

  const filename = `${slugify(gallery.title)}-${scope}.zip`;

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });

  // Source files are already-compressed JPEGs — store them verbatim.
  const archive = new ZipArchive({ store: true });
  archive.on("error", (err: Error) => {
    request.log.error({ err, galleryId: gallery.id }, "zip archive error");
    reply.raw.destroy(err);
  });
  archive.pipe(reply.raw);

  // Different photos can share an original filename (same camera, two cards);
  // identical zip entry names would silently overwrite on extract.
  const usedNames = new Set<string>();
  for (const photo of photos) {
    archive.file(originalPath(photo.galleryId, photo.id, photo.fileExt), {
      name: uniqueEntryName(photo.originalFilename, usedNames),
    });
  }

  await archive.finalize();
  return true;
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
