import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import {
  hasGalleryAccess,
  isGalleryExpired,
  requireGalleryAccess,
  resolveGalleryBySlug,
} from "../../services/photoAccess.ts";
import {
  GALLERY_ACCESS_TTL_SECONDS,
  galleryAccessCookieName,
  hashPassword,
  issueGalleryAccessToken,
  verifyPassword,
} from "../../services/auth.ts";
import { checkRateLimit, recordAttempt } from "../../services/rateLimiter.ts";
import { streamGalleryZip } from "../../services/zip.ts";
import { notifySelectionSubmitted } from "../../services/notify.ts";
import { ensureClientToken, getClientIp } from "../../lib/http.ts";
import { config } from "../../config.ts";

const DEFAULT_PAGE_SIZE = 180;

// Minimum spacing between selection-submit notifications for one gallery. A
// real re-submit is minutes apart; this only collapses rapid/scripted repeats.
const SUBMIT_DEBOUNCE_MS = 60_000;

export async function publicGalleryRoutes(app: FastifyInstance) {
  // Landing metadata — intentionally public. Its whole purpose is to tell the
  // client whether a password is needed; the slug itself (not this endpoint)
  // is the actual secret, so revealing exists-or-not here is fine. This is
  // NOT the brute-force-sensitive endpoint — that's /unlock below.
  app.get<{ Params: { slug: string } }>("/api/gallery/:slug", async (request, reply) => {
    const gallery = await resolveGalleryBySlug(request.params.slug);
    if (!gallery) return reply.code(404).send({ error: "not_found" });

    // A friendly "expired" state rather than a bare 404 — the link holder knew
    // the gallery existed, so telling them it's expired is the kinder answer.
    if (isGalleryExpired(gallery)) {
      return {
        slug: gallery.slug,
        title: gallery.title,
        requiresPassword: false,
        hasAccess: false,
        expired: true,
        photoCount: 0,
        favoriteCount: 0,
        allowDownloads: false,
        coverPhotoId: null,
      };
    }

    ensureClientToken(request, reply);
    const hasAccess = await hasGalleryAccess(request, gallery);

    // Counts only past the password gate — a locked gallery reveals nothing
    // beyond its title and that it exists.
    let photoCount = 0;
    let favoriteCount = 0;
    if (hasAccess) {
      const [photos] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.photos)
        .where(and(eq(schema.photos.galleryId, gallery.id), eq(schema.photos.status, "ready")));
      const [favorites] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.favorites)
        .where(eq(schema.favorites.galleryId, gallery.id));
      photoCount = photos?.count ?? 0;
      favoriteCount = favorites?.count ?? 0;
    }

    return {
      slug: gallery.slug,
      title: gallery.title,
      requiresPassword: Boolean(gallery.passwordHash),
      hasAccess,
      expired: false,
      photoCount,
      favoriteCount,
      allowDownloads: hasAccess ? gallery.allowDownloads : false,
      coverPhotoId: hasAccess ? gallery.coverPhotoId : null,
      selectionSubmittedAt:
        hasAccess && gallery.selectionSubmittedAt ? gallery.selectionSubmittedAt.toISOString() : null,
    };
  });

  /** Client-facing zip download — only when the photographer has opted the
   * gallery into downloads, and always behind the same access gate as the
   * photos themselves. */
  app.get<{ Params: { slug: string }; Querystring: { scope?: string } }>(
    "/api/gallery/:slug/download",
    { preHandler: requireGalleryAccess },
    async (request, reply) => {
      const gallery = request.gallery!;
      if (!gallery.allowDownloads) {
        return reply.code(403).send({ error: "downloads_disabled" });
      }
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

  app.post<{ Params: { slug: string }; Body: { password: string } }>(
    "/api/gallery/:slug/unlock",
    {
      schema: {
        body: {
          type: "object",
          required: ["password"],
          properties: { password: { type: "string", maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const gallery = await resolveGalleryBySlug(request.params.slug);
      const ip = getClientIp(request);

      if (gallery && isGalleryExpired(gallery)) {
        return reply.code(410).send({ error: "expired" });
      }

      const rateLimit = await checkRateLimit({ scope: "gallery_unlock", galleryId: gallery?.id, ip });
      if (!rateLimit.allowed) {
        reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
        return reply
          .code(429)
          .send({ error: "too_many_attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
      }

      const { password } = request.body;

      // Always run a verify (against a dummy hash if the gallery doesn't
      // exist or has no password) so response timing doesn't leak whether the
      // slug or password guess was right. A passwordless gallery has nothing
      // to verify — that's treated as an immediate success below instead.
      let ok: boolean;
      if (gallery && gallery.passwordHash) {
        ok = await verifyPassword(gallery.passwordHash, password);
      } else {
        await verifyPassword(DUMMY_HASH, password);
        ok = Boolean(gallery && !gallery.passwordHash);
      }

      await recordAttempt({ scope: "gallery_unlock", galleryId: gallery?.id, ip, success: ok });

      if (!gallery || !ok) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const token = await issueGalleryAccessToken(gallery.id, gallery.passwordVersion);
      reply.setCookie(galleryAccessCookieName(gallery.id), token, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: GALLERY_ACCESS_TTL_SECONDS,
      });
      ensureClientToken(request, reply);

      return { ok: true };
    },
  );

  app.get<{
    Params: { slug: string };
    Querystring: { cursor?: string; limit?: string; favorites?: string };
  }>(
    "/api/gallery/:slug/photos",
    { preHandler: requireGalleryAccess },
    async (request, reply) => {
      const gallery = request.gallery!;
      const limit = Math.min(Number(request.query.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 500);
      const cursor = request.query.cursor ? Number(request.query.cursor) : undefined;
      const favoritesOnly = request.query.favorites === "1" || request.query.favorites === "true";

      const conditions = [eq(schema.photos.galleryId, gallery.id), eq(schema.photos.status, "ready")];
      if (cursor !== undefined) conditions.push(gt(schema.photos.sortIndex, cursor));
      if (favoritesOnly) conditions.push(isNotNull(schema.favorites.id));

      const rows = await db
        .select({ photo: schema.photos, favoriteId: schema.favorites.id })
        .from(schema.photos)
        .leftJoin(
          schema.favorites,
          and(eq(schema.favorites.galleryId, schema.photos.galleryId), eq(schema.favorites.photoId, schema.photos.id)),
        )
        .where(and(...conditions))
        .orderBy(asc(schema.photos.sortIndex))
        .limit(limit);

      const photos = rows.map(({ photo, favoriteId }) => toPhotoDTO(photo, Boolean(favoriteId)));
      const nextCursor = photos.length === limit ? String(rows[rows.length - 1]!.photo.sortIndex) : null;

      return { photos, nextCursor };
    },
  );

  app.post<{ Params: { slug: string; photoId: string } }>(
    "/api/gallery/:slug/photos/:photoId/favorite",
    { preHandler: requireGalleryAccess },
    async (request, reply) => {
      const gallery = request.gallery!;
      const { photoId } = request.params;

      const [photo] = await db
        .select({ id: schema.photos.id })
        .from(schema.photos)
        .where(and(eq(schema.photos.id, photoId), eq(schema.photos.galleryId, gallery.id)))
        .limit(1);
      if (!photo) return reply.code(404).send({ error: "not_found" });

      const [existing] = await db
        .select({ id: schema.favorites.id })
        .from(schema.favorites)
        .where(and(eq(schema.favorites.galleryId, gallery.id), eq(schema.favorites.photoId, photoId)))
        .limit(1);

      if (existing) {
        await db.delete(schema.favorites).where(eq(schema.favorites.id, existing.id));
        return { favorited: false };
      }

      // Two rapid taps can both pass the SELECT above; the unique index on
      // (gallery_id, photo_id) makes the second insert a no-op, not a 500.
      await db
        .insert(schema.favorites)
        .values({
          galleryId: gallery.id,
          photoId,
          toggledByClientToken: request.clientToken ?? "unknown",
        })
        .onConflictDoNothing();
      return { favorited: true };
    },
  );

  /** The client marks their picks final. Records the moment (the "needs
   * attention" signal for the photographer), stores an optional note, and
   * fires the webhook if one is configured. Re-submittable — a client can add
   * more favorites and send again. */
  app.post<{ Params: { slug: string }; Body: { note?: string } }>(
    "/api/gallery/:slug/submit",
    {
      preHandler: requireGalleryAccess,
      schema: {
        body: {
          type: "object",
          properties: { note: { type: "string", maxLength: 2000 } },
        },
      },
    },
    async (request) => {
      const gallery = request.gallery!;

      const [fav] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.favorites)
        .where(eq(schema.favorites.galleryId, gallery.id));
      const favoriteCount = fav?.count ?? 0;

      // Debounce: this endpoint is re-submittable by design, but it fires an
      // outbound webhook and rewrites the gallery row on every call. Without a
      // throttle, anyone past the (possibly passwordless) access gate could
      // loop it to flood the photographer's Discord/Slack/ntfy channel — enough
      // to get the webhook provider-side rate-limited — and churn the DB. A
      // genuine re-submit (client adds picks, sends again) is minutes apart, so
      // collapsing calls within a short window costs nothing real while bounding
      // abuse to at most one notification per window.
      const now = Date.now();
      const lastSubmit = gallery.selectionSubmittedAt?.getTime() ?? 0;
      if (now - lastSubmit < SUBMIT_DEBOUNCE_MS) {
        return { ok: true, favoriteCount };
      }

      const note = request.body?.note?.trim() || null;

      await db
        .update(schema.galleries)
        .set({ selectionSubmittedAt: new Date(), selectionNote: note, updatedAt: new Date() })
        .where(eq(schema.galleries.id, gallery.id));

      // Fire-and-forget — the client's response doesn't wait on the webhook.
      void notifySelectionSubmitted({
        galleryTitle: gallery.title,
        gallerySlug: gallery.slug,
        favoriteCount,
        note,
      });

      return { ok: true, favoriteCount };
    },
  );
}

function toPhotoDTO(photo: typeof schema.photos.$inferSelect, favorited: boolean) {
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

// A real Argon2id hash (computed once at boot) used to force the same
// expensive verify computation whether or not the gallery/password guess was
// right, so response timing doesn't leak which case it was.
const DUMMY_HASH = await hashPassword(`dummy-${Math.random()}`);
