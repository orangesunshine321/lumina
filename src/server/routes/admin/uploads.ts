import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import sharp from "sharp";
import { db, schema } from "../../db/client.ts";
import { config } from "../../config.ts";
import { generateId } from "../../lib/ids.ts";
import { ensureGalleryDirs, originalPath } from "../../lib/storage.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { progressBus, type PhotoProgressEvent } from "../../services/worker.ts";
import { getSettings } from "../../services/settings.ts";

function toPhotoDTO(photo: typeof schema.photos.$inferSelect, favorited = false) {
  return {
    id: photo.id,
    originalFilename: photo.originalFilename,
    baseFilename: photo.baseFilename,
    width: photo.width,
    height: photo.height,
    thumbhash: photo.thumbhash,
    status: photo.status,
    sortIndex: photo.sortIndex,
    favorited,
    urls: {
      thumb: `/api/photos/${photo.id}/thumb`,
      thumb2x: `/api/photos/${photo.id}/thumb2x`,
      preview: `/api/photos/${photo.id}/preview`,
      preview2x: `/api/photos/${photo.id}/preview2x`,
      original: `/api/photos/${photo.id}/original`,
    },
  };
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { files: Array<{ filename: string; size: number }> } }>(
    "/api/admin/galleries/:id/uploads/check",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              maxItems: 5000,
              items: {
                type: "object",
                required: ["filename", "size"],
                properties: {
                  filename: { type: "string", maxLength: 512 },
                  size: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { files } = request.body;
      if (!files?.length) return { existing: [] };

      // Failed rows are deliberately NOT treated as existing: re-selecting the
      // same folder is the recovery path for a photo that failed processing.
      const rows = await db
        .select({ filename: schema.photos.originalFilename, size: schema.photos.byteSize })
        .from(schema.photos)
        .where(and(eq(schema.photos.galleryId, id), ne(schema.photos.status, "failed")));

      // Return the composite filename:size KEY (not the bare filename) so the
      // client can skip only files that match on both. Returning just the name
      // would let the client drop a genuinely-new photo that happens to share a
      // filename with an existing one (e.g. two different frames both named
      // IMG_0001.jpg) — silent data loss, since the skipped file never reaches
      // the server's authoritative checksum dedup.
      const known = new Set(rows.map((r) => `${r.filename}:${r.size}`));
      const existing = files
        .map((f) => `${f.filename}:${f.size}`)
        .filter((key) => known.has(key));
      return { existing };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/galleries/:id/uploads",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id: galleryId } = request.params;
      const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, galleryId)).limit(1);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      let part;
      try {
        part = await request.file();
      } catch (err: any) {
        if (err?.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw err;
      }
      if (!part) return reply.code(400).send({ error: "no_file" });

      await mkdir(config.uploadTmpDir, { recursive: true });
      const tmpPath = join(config.uploadTmpDir, `${generateId()}.tmp`);
      const hash = createHash("sha256");
      let byteSize = 0;
      part.file.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        byteSize += chunk.length;
      });

      try {
        await pipeline(part.file, createWriteStream(tmpPath));
      } catch (err: any) {
        await rm(tmpPath, { force: true });
        if (part.file.truncated) {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw err;
      }

      if (part.file.truncated) {
        await rm(tmpPath, { force: true });
        return reply.code(413).send({ error: "file_too_large" });
      }

      // Enforce the operator's (live-tunable) max upload size. The multipart
      // plugin's own limit is a fixed hard ceiling above this, so a smaller
      // admin-configured limit is enforced here.
      const settings = await getSettings();
      if (byteSize > settings.maxUploadFileSizeBytes) {
        await rm(tmpPath, { force: true });
        return reply.code(413).send({ error: "file_too_large" });
      }

      // metadata() only reads the header, so it's cheap at any declared size —
      // no limitInputPixels here, or it would throw before the explicit pixel
      // check below can return the clean "image_too_large" error. The pipeline
      // arms limitInputPixels for the actual decode.
      const meta = await sharp(tmpPath).metadata().catch(() => null);
      if (!meta || meta.format !== "jpeg") {
        await rm(tmpPath, { force: true });
        return reply.code(400).send({ error: "invalid_file_type" });
      }

      // Decompression-bomb guard: a small file can declare enormous pixel
      // dimensions that blow up memory when sharp decodes it. Reject anything
      // whose pixel count exceeds the cap before any full decode happens.
      // (maxImagePixels also arms sharp's own limitInputPixels in the pipeline,
      // so this is defense in depth, not the only check.)
      const pixels = (meta.width ?? 0) * (meta.height ?? 0);
      if (pixels === 0 || pixels > settings.maxImagePixels) {
        await rm(tmpPath, { force: true });
        return reply.code(400).send({ error: "image_too_large" });
      }

      const checksumSha256 = hash.digest("hex");
      const existingPhoto = await findByChecksum(galleryId, checksumSha256);

      if (existingPhoto) {
        await rm(tmpPath, { force: true });
        const photo = await resetIfFailed(existingPhoto);
        return { duplicate: true, photo: toPhotoDTO(photo) };
      }

      // Defense in depth: the browser normally sends just a basename, but
      // never trust it — strip any path components/control characters before
      // it's used as a DB value, a disk-adjacent zip entry name (downloads),
      // and part of the Lightroom export text.
      const originalFilename = sanitizeFilename(part.filename);
      const lastDot = originalFilename.lastIndexOf(".");
      const baseFilename = lastDot > 0 ? originalFilename.slice(0, lastDot) : originalFilename;
      const fileExt = (lastDot > 0 ? originalFilename.slice(lastDot + 1) : "jpg").toLowerCase();

      const photoId = generateId();
      await ensureGalleryDirs(galleryId);
      const finalPath = originalPath(galleryId, photoId, fileExt);
      await rename(tmpPath, finalPath);

      let photo: typeof schema.photos.$inferSelect;
      try {
        // sortIndex is computed inside the INSERT itself: a separate
        // SELECT MAX + INSERT pair has an await between them, and two of
        // Uppy's concurrent uploads can interleave there and take the same
        // index — which the gt(sortIndex, cursor) pagination would then
        // silently skip past. One statement makes the assignment atomic.
        const [inserted] = await db
          .insert(schema.photos)
          .values({
            id: photoId,
            galleryId,
            originalFilename,
            baseFilename,
            fileExt,
            byteSize,
            checksumSha256,
            status: "pending",
            sortIndex: sql`(SELECT COALESCE(MAX(sort_index), -1) + 1 FROM photos WHERE gallery_id = ${galleryId})`,
          })
          .returning();
        photo = inserted!;
      } catch (err) {
        // The file has already been moved into originals/ — never leave it
        // orphaned, whatever the insert failure was.
        await rm(finalPath, { force: true });
        if (isUniqueConstraintError(err)) {
          // Lost a race with a concurrent upload of identical bytes.
          const winner = await findByChecksum(galleryId, checksumSha256);
          if (winner) {
            return { duplicate: true, photo: toPhotoDTO(await resetIfFailed(winner)) };
          }
        }
        throw err;
      }

      await db
        .update(schema.galleries)
        // Recount from the source of truth in one atomic statement rather than
        // `photoCount + 1`: a read-modify-write increment can interleave with a
        // concurrent delete (which also recounts) and leave the count drifted.
        // A single-statement recount always reflects the true row count at the
        // moment the last mutation's update runs.
        .set({
          photoCount: sql`(select count(*) from photos where gallery_id = ${galleryId})`,
          updatedAt: new Date(),
        })
        .where(eq(schema.galleries.id, galleryId));

      return toPhotoDTO(photo);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string; filter?: string };
  }>(
    "/api/admin/galleries/:id/photos",
    { preHandler: requireAdmin },
    async (request) => {
      const { id: galleryId } = request.params;
      const limit = Math.min(Number(request.query.limit ?? 180), 500);
      const cursor = request.query.cursor ? Number(request.query.cursor) : undefined;

      const conditions = [eq(schema.photos.galleryId, galleryId)];
      if (cursor !== undefined && !Number.isNaN(cursor)) {
        conditions.push(gt(schema.photos.sortIndex, cursor));
      }
      // Toolbar filters for the admin grid — server-side so they compose
      // with cursor pagination on large galleries.
      if (request.query.filter === "failed") {
        conditions.push(eq(schema.photos.status, "failed"));
      } else if (request.query.filter === "favorites") {
        conditions.push(
          sql`exists (select 1 from favorites f where f.gallery_id = ${galleryId} and f.photo_id = ${schema.photos.id})`,
        );
      }

      const rows = await db
        .select()
        .from(schema.photos)
        .where(and(...conditions))
        .orderBy(asc(schema.photos.sortIndex))
        .limit(limit);

      const favorites = await db
        .select({ photoId: schema.favorites.photoId })
        .from(schema.favorites)
        .where(eq(schema.favorites.galleryId, galleryId));
      const favoritedIds = new Set(favorites.map((f) => f.photoId));

      const photos = rows.map((row) => toPhotoDTO(row, favoritedIds.has(row.id)));
      const nextCursor = rows.length === limit ? String(rows[rows.length - 1]!.sortIndex) : null;

      return { photos, nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/galleries/:id/photos/stream",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id: galleryId } = request.params;

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(": connected\n\n");

      const listener = (event: PhotoProgressEvent) => {
        if (event.galleryId !== galleryId) return;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      progressBus.on("progress", listener);

      request.raw.on("close", () => {
        progressBus.off("progress", listener);
        reply.raw.end();
      });
    },
  );
}

async function findByChecksum(galleryId: string, checksumSha256: string) {
  const [photo] = await db
    .select()
    .from(schema.photos)
    .where(and(eq(schema.photos.galleryId, galleryId), eq(schema.photos.checksumSha256, checksumSha256)))
    .limit(1);
  return photo ?? null;
}

/** Re-uploading a photo whose processing permanently failed is the recovery
 * path for it — requeue instead of just reporting "duplicate". */
async function resetIfFailed(photo: typeof schema.photos.$inferSelect) {
  if (photo.status !== "failed") return photo;
  const [updated] = await db
    .update(schema.photos)
    .set({ status: "pending", attempts: 0, lastError: null })
    .where(eq(schema.photos.id, photo.id))
    .returning();
  return updated ?? photo;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: string }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, ""); // strip any path components
  // eslint-disable-next-line no-control-regex
  const stripped = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const safe = stripped.length > 0 ? stripped : "photo.jpg";
  return safe.slice(0, 255);
}
