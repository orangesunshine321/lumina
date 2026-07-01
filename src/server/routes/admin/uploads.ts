import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import sharp from "sharp";
import { db, schema } from "../../db/client.ts";
import { config } from "../../config.ts";
import { generateId } from "../../lib/ids.ts";
import { ensureGalleryDirs, originalPath } from "../../lib/storage.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { progressBus, type PhotoProgressEvent } from "../../services/worker.ts";

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
    { preHandler: requireAdmin },
    async (request) => {
      const { id } = request.params;
      const { files } = request.body;
      if (!files?.length) return { existing: [] };

      const rows = await db
        .select({ filename: schema.photos.originalFilename, size: schema.photos.byteSize })
        .from(schema.photos)
        .where(eq(schema.photos.galleryId, id));

      const known = new Set(rows.map((r) => `${r.filename}:${r.size}`));
      const existing = files
        .filter((f) => known.has(`${f.filename}:${f.size}`))
        .map((f) => f.filename);
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

      const meta = await sharp(tmpPath)
        .metadata()
        .catch(() => null);
      if (!meta || meta.format !== "jpeg") {
        await rm(tmpPath, { force: true });
        return reply.code(400).send({ error: "invalid_file_type" });
      }

      const checksumSha256 = hash.digest("hex");
      const [existingPhoto] = await db
        .select()
        .from(schema.photos)
        .where(and(eq(schema.photos.galleryId, galleryId), eq(schema.photos.checksumSha256, checksumSha256)))
        .limit(1);

      if (existingPhoto) {
        await rm(tmpPath, { force: true });
        return { duplicate: true, photo: toPhotoDTO(existingPhoto) };
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
      await rename(tmpPath, originalPath(galleryId, photoId, fileExt));

      const nextSortRows = await db
        .select({ nextSort: sql<number>`coalesce(max(${schema.photos.sortIndex}), -1) + 1` })
        .from(schema.photos)
        .where(eq(schema.photos.galleryId, galleryId));
      const nextSort = nextSortRows[0]?.nextSort ?? 0;

      const [photo] = await db
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
          sortIndex: nextSort,
        })
        .returning();

      await db
        .update(schema.galleries)
        .set({ photoCount: sql`${schema.galleries.photoCount} + 1`, updatedAt: new Date() })
        .where(eq(schema.galleries.id, galleryId));

      return toPhotoDTO(photo!);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
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

function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, ""); // strip any path components
  // eslint-disable-next-line no-control-regex
  const stripped = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const safe = stripped.length > 0 ? stripped : "photo.jpg";
  return safe.slice(0, 255);
}
