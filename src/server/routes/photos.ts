import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "../services/auth.ts";
import { hasGalleryAccess, isGalleryExpired, resolveGalleryById } from "../services/photoAccess.ts";
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
  app.get<{ Params: { photoId: string; variant: Variant }; Querystring: { download?: string } }>(
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
      // Non-admins are blocked once the gallery link has expired (admins keep
      // full access to manage it).
      if (!isAdmin && (isGalleryExpired(gallery) || !(await hasGalleryAccess(request, gallery)))) {
        return reply.code(403).send({ error: "forbidden" });
      }

      let filePath: string;
      let contentType: string;
      if (variant === "original") {
        // Full-res originals for clients are opt-in per gallery — browsing
        // only ever needs the derived previews. Admins always have access.
        if (!isAdmin && !gallery.allowDownloads) {
          return reply.code(403).send({ error: "downloads_disabled" });
        }
        filePath = originalPath(photo.galleryId, photo.id, photo.fileExt);
        contentType = MIME_BY_EXT[photo.fileExt.toLowerCase()] ?? "application/octet-stream";
        if (request.query.download === "1") {
          reply.header(
            "Content-Disposition",
            `attachment; filename="${photo.originalFilename.replaceAll('"', "")}"`,
          );
        }
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
        const parsed = parseRange(range, fileStat.size);
        if (parsed === "invalid") {
          reply.code(416);
          reply.header("Content-Range", `bytes */${fileStat.size}`);
          return reply.send();
        }
        if (parsed) {
          reply.code(206);
          reply.header("Content-Range", `bytes ${parsed.start}-${parsed.end}/${fileStat.size}`);
          reply.header("Content-Length", parsed.end - parsed.start + 1);
          return reply.send(createReadStream(filePath, { start: parsed.start, end: parsed.end }));
        }
      }

      reply.header("Content-Length", fileStat.size);
      return reply.send(createReadStream(filePath));
    },
  );
}

/** RFC 9110 single-range parsing, including suffix ranges (`bytes=-500` =
 * last 500 bytes). Returns null for a malformed/unsupported header (serve the
 * full 200) and "invalid" for a syntactically valid but unsatisfiable range
 * (416) — resuming download managers depend on getting these right. */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  const [, startStr, endStr] = match;

  if (!startStr && !endStr) return null;

  if (!startStr) {
    // Suffix range: last N bytes.
    const suffixLength = Number(endStr);
    if (suffixLength === 0) return "invalid";
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }

  const start = Number(startStr);
  const end = endStr ? Math.min(Number(endStr), size - 1) : size - 1;
  if (start >= size || start > end) return "invalid";
  return { start, end };
}
