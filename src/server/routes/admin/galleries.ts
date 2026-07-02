import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { generateId, generateSlug } from "../../lib/ids.ts";
import { hashPassword } from "../../services/auth.ts";
import { deleteGalleryFiles } from "../../lib/storage.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";

interface GalleryDTO {
  id: string;
  slug: string;
  title: string;
  hasPassword: boolean;
  coverPhotoId: string | null;
  photoCount: number;
  favoriteCount: number;
  allowDownloads: boolean;
  lastFavoriteAt: string | null;
  statusCounts: { pending: number; processing: number; failed: number };
  createdAt: string;
  updatedAt: string;
}

interface GalleryExtras {
  favoriteCount: number;
  lastFavoriteAt?: Date | null;
  statusCounts?: { pending: number; processing: number; failed: number };
}

const ZERO_COUNTS = { pending: 0, processing: 0, failed: 0 };

function toDTO(row: typeof schema.galleries.$inferSelect, extras: GalleryExtras): GalleryDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    hasPassword: Boolean(row.passwordHash),
    coverPhotoId: row.coverPhotoId,
    photoCount: row.photoCount,
    favoriteCount: extras.favoriteCount,
    allowDownloads: row.allowDownloads,
    lastFavoriteAt: extras.lastFavoriteAt ? extras.lastFavoriteAt.toISOString() : null,
    statusCounts: extras.statusCounts ?? ZERO_COUNTS,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function extrasFor(galleryId: string): Promise<GalleryExtras> {
  const [favorites] = await db
    .select({
      count: sql<number>`count(*)`,
      lastAt: sql<number | null>`max(${schema.favorites.createdAt})`,
    })
    .from(schema.favorites)
    .where(eq(schema.favorites.galleryId, galleryId));

  const statusRows = await db
    .select({ status: schema.photos.status, count: sql<number>`count(*)` })
    .from(schema.photos)
    .where(eq(schema.photos.galleryId, galleryId))
    .groupBy(schema.photos.status);
  const statusCounts = { ...ZERO_COUNTS };
  for (const row of statusRows) {
    if (row.status === "pending") statusCounts.pending = row.count;
    if (row.status === "processing") statusCounts.processing = row.count;
    if (row.status === "failed") statusCounts.failed = row.count;
  }

  return {
    favoriteCount: favorites?.count ?? 0,
    lastFavoriteAt: favorites?.lastAt ? new Date(favorites.lastAt) : null,
    statusCounts,
  };
}

export async function galleryAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.post<{ Body: { title: string } }>(
    "/api/admin/galleries",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const id = generateId();
      const slug = generateSlug();
      const [created] = await db
        .insert(schema.galleries)
        .values({
          id,
          slug,
          title: request.body.title,
          passwordHash: null,
          passwordVersion: 0,
        })
        .returning();

      reply.code(201);
      return toDTO(created!, { favoriteCount: 0 });
    },
  );

  app.get("/api/admin/galleries", async () => {
    const rows = await db
      .select({
        gallery: schema.galleries,
        favoriteCount: sql<number>`count(${schema.favorites.id})`,
        lastFavoriteAt: sql<number | null>`max(${schema.favorites.createdAt})`,
      })
      .from(schema.galleries)
      .leftJoin(schema.favorites, eq(schema.favorites.galleryId, schema.galleries.id))
      .groupBy(schema.galleries.id)
      .orderBy(desc(schema.galleries.createdAt));
    return {
      galleries: rows.map((r) =>
        toDTO(r.gallery, {
          favoriteCount: r.favoriteCount,
          lastFavoriteAt: r.lastFavoriteAt ? new Date(r.lastFavoriteAt) : null,
        }),
      ),
    };
  });

  app.get<{ Params: { id: string } }>("/api/admin/galleries/:id", async (request, reply) => {
    const gallery = await findGallery(request.params.id);
    if (!gallery) return reply.code(404).send({ error: "not_found" });
    return toDTO(gallery, await extrasFor(gallery.id));
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; password?: string | null; coverPhotoId?: string; allowDownloads?: boolean };
  }>(
    "/api/admin/galleries/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            password: { type: ["string", "null"], maxLength: 512 },
            coverPhotoId: { type: "string", maxLength: 64 },
            allowDownloads: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const update: Partial<typeof schema.galleries.$inferInsert> = { updatedAt: new Date() };

      if (typeof request.body.title === "string") {
        update.title = request.body.title;
      }

      if (typeof request.body.allowDownloads === "boolean") {
        update.allowDownloads = request.body.allowDownloads;
      }

      if (typeof request.body.coverPhotoId === "string") {
        const [photo] = await db
          .select({ id: schema.photos.id })
          .from(schema.photos)
          .where(
            and(
              eq(schema.photos.id, request.body.coverPhotoId),
              eq(schema.photos.galleryId, gallery.id),
              eq(schema.photos.status, "ready"),
            ),
          )
          .limit(1);
        if (!photo) return reply.code(400).send({ error: "invalid_cover_photo" });
        update.coverPhotoId = photo.id;
      }

      if ("password" in request.body) {
        const password = request.body.password;
        if (typeof password === "string" && password.length > 0) {
          update.passwordHash = await hashPassword(password);
        } else {
          // Explicit null (or empty string): remove the password entirely.
          update.passwordHash = null;
        }
        // Bumping the version instantly invalidates every previously-issued
        // gallery-access cookie, whether we just set, changed, or removed
        // the password — all three are security-relevant changes.
        update.passwordVersion = gallery.passwordVersion + 1;
      }

      const [updated] = await db
        .update(schema.galleries)
        .set(update)
        .where(eq(schema.galleries.id, gallery.id))
        .returning();

      return toDTO(updated!, await extrasFor(gallery.id));
    },
  );

  /** Issues a fresh unguessable link. The old slug 404s immediately — the
   * recovery move when a gallery link has been shared further than intended. */
  app.post<{ Params: { id: string } }>(
    "/api/admin/galleries/:id/regenerate-slug",
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const [updated] = await db
        .update(schema.galleries)
        .set({ slug: generateSlug(), updatedAt: new Date() })
        .where(eq(schema.galleries.id, gallery.id))
        .returning();
      return toDTO(updated!, await extrasFor(gallery.id));
    },
  );

  /** Rewrites sortIndex for every photo in the gallery. Filename order is the
   * upload default; capture-time ordering fixes multi-camera shoots where
   * DSC_/IMG_ sequences interleave wrongly. One-shot operation — pagination
   * cursors and the client grid pick the new order up on their next fetch. */
  app.post<{
    Params: { id: string };
    Body: { by: "capturedAt" | "filename"; direction?: "asc" | "desc" };
  }>(
    "/api/admin/galleries/:id/reorder",
    {
      schema: {
        body: {
          type: "object",
          required: ["by"],
          properties: {
            by: { type: "string", enum: ["capturedAt", "filename"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const photos = await db
        .select({
          id: schema.photos.id,
          capturedAt: schema.photos.capturedAt,
          baseFilename: schema.photos.baseFilename,
        })
        .from(schema.photos)
        .where(eq(schema.photos.galleryId, gallery.id));

      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const dir = request.body.direction === "desc" ? -1 : 1;
      const sorted = [...photos].sort((a, b) => {
        if (request.body.by === "capturedAt") {
          const aTime = a.capturedAt?.getTime();
          const bTime = b.capturedAt?.getTime();
          if (aTime !== undefined && bTime !== undefined && aTime !== bTime) {
            return (aTime - bTime) * dir;
          }
          // Photos without EXIF sort last regardless of direction.
          if (aTime !== undefined && bTime === undefined) return -1;
          if (aTime === undefined && bTime !== undefined) return 1;
        }
        return collator.compare(a.baseFilename, b.baseFilename) * dir;
      });

      const reassign = db.$client.transaction(() => {
        const stmt = db.$client.prepare("UPDATE photos SET sort_index = ? WHERE id = ?");
        sorted.forEach((photo, index) => stmt.run(index, photo.id));
      });
      reassign();

      return { ok: true, reordered: sorted.length };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/galleries/:id", async (request, reply) => {
    const gallery = await findGallery(request.params.id);
    if (!gallery) return reply.code(404).send({ error: "not_found" });

    await db.delete(schema.galleries).where(eq(schema.galleries.id, gallery.id));

    try {
      await deleteGalleryFiles(gallery.id);
    } catch (err) {
      request.log.warn({ err, galleryId: gallery.id }, "failed to delete gallery files on disk");
    }

    return { ok: true };
  });
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}
