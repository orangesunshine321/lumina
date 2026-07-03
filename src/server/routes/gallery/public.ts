import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
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
import { collectZipEntries, streamPhotoZip } from "../../services/zip.ts";
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
        downloadableFavoriteCount: 0,
        allowDownloads: false,
        coverPhotoId: null,
        sets: [],
        ungroupedCount: 0,
      };
    }

    ensureClientToken(request, reply);
    const hasAccess = await hasGalleryAccess(request, gallery);

    // Counts only past the password gate — a locked gallery reveals nothing
    // beyond its title and that it exists (and must NOT leak set names/counts).
    let photoCount = 0;
    let favoriteCount = 0;
    let downloadableFavoriteCount = 0;
    let ungroupedCount = 0;
    let coverPhotoId: string | null = null;
    let sets: { id: string; title: string; allowDownloads: boolean; photoCount: number }[] = [];
    if (hasAccess) {
      const allSets = await db
        .select()
        .from(schema.photoSets)
        .where(eq(schema.photoSets.galleryId, gallery.id))
        .orderBy(asc(schema.photoSets.sortIndex));

      // Ready-photo counts keyed by setId (null = ungrouped), in one grouped query.
      const grouped = await db
        .select({ setId: schema.photos.setId, count: sql<number>`count(*)` })
        .from(schema.photos)
        .where(and(eq(schema.photos.galleryId, gallery.id), eq(schema.photos.status, "ready")))
        .groupBy(schema.photos.setId);
      const countBy = new Map(grouped.map((g) => [g.setId, g.count]));

      ungroupedCount = countBy.get(null) ?? 0;
      photoCount = ungroupedCount; // client-visible total: ungrouped + visible sets only
      for (const s of allSets) {
        if (!s.visibleToClient) continue; // hidden sets are invisible to the client
        const c = countBy.get(s.id) ?? 0;
        photoCount += c;
        sets.push({ id: s.id, title: s.title, allowDownloads: s.allowDownloads, photoCount: c });
      }

      // Favorites among CLIENT-VISIBLE photos only (a pick in a since-hidden set
      // shouldn't inflate the count the client sees), and how many of those the
      // client may actually download (drives the "Download favorites" option).
      favoriteCount = await countVisibleFavorites(gallery.id);
      downloadableFavoriteCount = await countDownloadableFavorites(gallery.id, gallery.allowDownloads);

      // Only expose the cover if the client can actually see it — a cover photo
      // in a hidden set would 404 on fetch and leave the hero broken.
      if (gallery.coverPhotoId) {
        const [cover] = await db
          .select({ id: schema.photos.id })
          .from(schema.photos)
          .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
          .where(
            and(
              eq(schema.photos.id, gallery.coverPhotoId),
              or(isNull(schema.photos.setId), eq(schema.photoSets.visibleToClient, true)),
            ),
          )
          .limit(1);
        coverPhotoId = cover?.id ?? null;
      }
    }

    return {
      slug: gallery.slug,
      title: gallery.title,
      requiresPassword: Boolean(gallery.passwordHash),
      hasAccess,
      expired: false,
      photoCount,
      favoriteCount,
      downloadableFavoriteCount,
      allowDownloads: hasAccess ? gallery.allowDownloads : false,
      coverPhotoId,
      selectionSubmittedAt:
        hasAccess && gallery.selectionSubmittedAt ? gallery.selectionSubmittedAt.toISOString() : null,
      sets,
      ungroupedCount,
    };
  });

  /** Client-facing zip download — only when the photographer has opted the
   * gallery into downloads, and always behind the same access gate as the
   * photos themselves. */
  app.get<{ Params: { slug: string }; Querystring: { scope?: string; setId?: string } }>(
    "/api/gallery/:slug/download",
    { preHandler: requireGalleryAccess },
    async (request, reply) => {
      const gallery = request.gallery!;
      const scope = request.query.scope ?? "all";
      const requestedSetId = request.query.setId;

      // Nothing is downloadable unless the gallery-level toggle is on (ungrouped
      // photos) OR at least one set is both visible and downloadable. If neither,
      // downloads are effectively disabled — a clear 403, not an empty archive.
      const [downloadableSet] = await db
        .select({ id: schema.photoSets.id })
        .from(schema.photoSets)
        .where(
          and(
            eq(schema.photoSets.galleryId, gallery.id),
            eq(schema.photoSets.visibleToClient, true),
            eq(schema.photoSets.allowDownloads, true),
          ),
        )
        .limit(1);
      if (!gallery.allowDownloads && !downloadableSet) {
        return reply.code(403).send({ error: "downloads_disabled" });
      }

      let entries;
      let filenameBase: string;
      let emptyError: string;

      if (scope === "favorites") {
        // Only favorites the client is actually allowed to download (visible +
        // downloadable sets, or ungrouped if the gallery permits it).
        entries = await collectZipEntries({
          galleryId: gallery.id,
          scope: "favorites",
          visibleOnly: true,
          downloadableOnly: true,
          galleryAllowDownloads: gallery.allowDownloads,
        });
        filenameBase = `${gallery.title}-favorites`;
        emptyError = "no_favorites";
      } else if (scope === "set") {
        if (!requestedSetId) return reply.code(400).send({ error: "invalid_scope" });
        if (requestedSetId === "ungrouped") {
          if (!gallery.allowDownloads) return reply.code(403).send({ error: "downloads_disabled" });
          entries = await collectZipEntries({ galleryId: gallery.id, scope: "set", setId: "ungrouped" });
          filenameBase = gallery.title;
        } else {
          const [set] = await db
            .select()
            .from(schema.photoSets)
            .where(and(eq(schema.photoSets.id, requestedSetId), eq(schema.photoSets.galleryId, gallery.id)))
            .limit(1);
          if (!set) return reply.code(404).send({ error: "not_found" });
          // A hidden or non-downloadable set is never downloadable by the client.
          if (!set.visibleToClient || !set.allowDownloads) {
            return reply.code(403).send({ error: "downloads_disabled" });
          }
          entries = await collectZipEntries({ galleryId: gallery.id, scope: "set", setId: set.id });
          filenameBase = set.title;
        }
        emptyError = "no_photos";
      } else if (scope === "all") {
        // Everything the client may download, foldered by set.
        entries = await collectZipEntries({
          galleryId: gallery.id,
          scope: "all",
          visibleOnly: true,
          downloadableOnly: true,
          galleryAllowDownloads: gallery.allowDownloads,
          folderBySet: true,
        });
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
    Querystring: { cursor?: string; limit?: string; favorites?: string; setId?: string };
  }>(
    "/api/gallery/:slug/photos",
    { preHandler: requireGalleryAccess },
    async (request, reply) => {
      const gallery = request.gallery!;
      const limit = Math.min(Number(request.query.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 500);
      const cursor = request.query.cursor ? Number(request.query.cursor) : undefined;
      const favoritesOnly = request.query.favorites === "1" || request.query.favorites === "true";
      const setFilter = request.query.setId;

      const conditions = [eq(schema.photos.galleryId, gallery.id), eq(schema.photos.status, "ready")];
      if (cursor !== undefined) conditions.push(gt(schema.photos.sortIndex, cursor));
      if (favoritesOnly) conditions.push(isNotNull(schema.favorites.id));
      // Never surface photos in a set the client can't see. A request for a
      // hidden set therefore just comes back empty (this condition kills it).
      conditions.push(or(isNull(schema.photos.setId), eq(schema.photoSets.visibleToClient, true))!);
      // Optional per-set view ("ungrouped" = photos in no set).
      if (setFilter === "ungrouped") {
        conditions.push(isNull(schema.photos.setId));
      } else if (setFilter) {
        conditions.push(eq(schema.photos.setId, setFilter));
      }

      const rows = await db
        .select({ photo: schema.photos, favoriteId: schema.favorites.id })
        .from(schema.photos)
        .leftJoin(
          schema.favorites,
          and(eq(schema.favorites.galleryId, schema.photos.galleryId), eq(schema.favorites.photoId, schema.photos.id)),
        )
        .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
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
        .select({ id: schema.photos.id, setId: schema.photos.setId, setVisible: schema.photoSets.visibleToClient })
        .from(schema.photos)
        .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
        .where(and(eq(schema.photos.id, photoId), eq(schema.photos.galleryId, gallery.id)))
        .limit(1);
      // A photo in a hidden set isn't visible to the client, so it can't be
      // favorited either — treat it as not found.
      if (!photo || (photo.setId && photo.setVisible === false)) {
        return reply.code(404).send({ error: "not_found" });
      }

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

      // Same visibility-filtered count the landing shows, so a pick made in a
      // since-hidden set isn't counted in the client's confirmation or webhook.
      const favoriteCount = await countVisibleFavorites(gallery.id);

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
    setId: photo.setId,
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

/** Count of favorited photos the client can SEE (ungrouped, or in a visible
 * set). Shared by the landing and submit responses so both agree. */
async function countVisibleFavorites(galleryId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.favorites)
    .innerJoin(
      schema.photos,
      and(eq(schema.favorites.photoId, schema.photos.id), eq(schema.photos.status, "ready")),
    )
    .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
    .where(
      and(
        eq(schema.favorites.galleryId, galleryId),
        or(isNull(schema.photos.setId), eq(schema.photoSets.visibleToClient, true)),
      ),
    );
  return row?.count ?? 0;
}

/** Count of favorited photos the client may DOWNLOAD (ungrouped iff the gallery
 * allows it, or in a visible + downloadable set). Drives whether "Download
 * favorites" is offered. */
async function countDownloadableFavorites(galleryId: string, galleryAllowDownloads: boolean): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.favorites)
    .innerJoin(
      schema.photos,
      and(eq(schema.favorites.photoId, schema.photos.id), eq(schema.photos.status, "ready")),
    )
    .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
    .where(
      and(
        eq(schema.favorites.galleryId, galleryId),
        or(
          galleryAllowDownloads ? isNull(schema.photos.setId) : sql`0`,
          and(eq(schema.photoSets.visibleToClient, true), eq(schema.photoSets.allowDownloads, true)),
        ),
      ),
    );
  return row?.count ?? 0;
}

// A real Argon2id hash (computed once at boot) used to force the same
// expensive verify computation whether or not the gallery/password guess was
// right, so response timing doesn't leak which case it was.
const DUMMY_HASH = await hashPassword(`dummy-${Math.random()}`);
