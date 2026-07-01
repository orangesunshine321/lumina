import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "../services/auth.ts";
import { hasGalleryAccess, resolveGalleryById } from "../services/photoAccess.ts";
import { derivedPath, originalPath, type DerivedVariant } from "../lib/storage.ts";

const VARIANTS = ["thumb", "thumb2x", "preview", "preview2x", "original"] as const;
type Variant = (typeof VARIANTS)[number];

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * The single source of truth for serving photo bytes. Every consumer — the
 * admin grid, the client-facing gallery, the lightbox — goes through this one
 * route, which independently re-validates access on every request rather
 * than trusting that a valid-looking URL implies permission.
 */
export async function photoRoutes(app: FastifyInstance) {
  app.get<{ Params: { photoId: string; variant: Variant } }>(
    "/api/photos/:photoId/:variant",
    async (request, reply) => {
      const { photoId, variant } = request.params;
      if (!VARIANTS.includes(variant)) {
        return reply.code(400).send({ error: "invalid_variant" });
      }

      const [photo] = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId)).limit(1);
      if (!photo) return reply.code(404).send({ error: "not_found" });

      const gallery = await resolveGalleryById(photo.galleryId);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const adminToken = request.cookies[ADMIN_SESSION_COOKIE];
      const isAdmin = Boolean(await verifyAdminSession(adminToken));
      if (!isAdmin && !(await hasGalleryAccess(request, gallery))) {
        return reply.code(403).send({ error: "forbidden" });
      }

      let filePath: string;
      let contentType: string;
      if (variant === "original") {
        filePath = originalPath(photo.galleryId, photo.id, photo.fileExt);
        contentType = MIME_BY_EXT[photo.fileExt.toLowerCase()] ?? "application/octet-stream";
      } else {
        if (photo.status !== "ready") {
          return reply.code(404).send({ error: "not_ready" });
        }
        filePath = derivedPath(photo.galleryId, photo.id, variant as DerivedVariant);
        contentType = "image/webp";
      }

      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        return reply.code(404).send({ error: "file_missing" });
      }

      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      reply.header("Accept-Ranges", "bytes");
      reply.type(contentType);

      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const [, startStr, endStr] = match;
          const start = startStr ? Number(startStr) : 0;
          const end = endStr ? Number(endStr) : fileStat.size - 1;
          if (start <= end && end < fileStat.size) {
            reply.code(206);
            reply.header("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
            reply.header("Content-Length", end - start + 1);
            return reply.send(createReadStream(filePath, { start, end }));
          }
        }
      }

      reply.header("Content-Length", fileStat.size);
      return reply.send(createReadStream(filePath));
    },
  );
}
