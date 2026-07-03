import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { generateId } from "../../lib/ids.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";

interface SetDTO {
  id: string;
  title: string;
  sortIndex: number;
  visibleToClient: boolean;
  allowDownloads: boolean;
  photoCount: number;
  createdAt: string;
}

function toSetDTO(row: typeof schema.photoSets.$inferSelect, photoCount: number): SetDTO {
  return {
    id: row.id,
    title: row.title,
    sortIndex: row.sortIndex,
    visibleToClient: row.visibleToClient,
    allowDownloads: row.allowDownloads,
    photoCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function setRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  // List a gallery's sets (+ how many photos are ungrouped).
  app.get<{ Params: { id: string } }>("/api/admin/galleries/:id/sets", async (request, reply) => {
    const gallery = await findGallery(request.params.id);
    if (!gallery) return reply.code(404).send({ error: "not_found" });

    const sets = await db
      .select()
      .from(schema.photoSets)
      .where(eq(schema.photoSets.galleryId, gallery.id))
      .orderBy(asc(schema.photoSets.sortIndex));

    const counts = await countBySet(gallery.id);

    return {
      sets: sets.map((s) => toSetDTO(s, counts.get(s.id) ?? 0)),
      ungroupedCount: counts.get(null) ?? 0,
    };
  });

  app.post<{ Params: { id: string }; Body: { title: string } }>(
    "/api/admin/galleries/:id/sets",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
        },
      },
    },
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const [max] = await db
        .select({ max: sql<number | null>`max(${schema.photoSets.sortIndex})` })
        .from(schema.photoSets)
        .where(eq(schema.photoSets.galleryId, gallery.id));
      const nextIndex = (max?.max ?? -1) + 1;

      const [created] = await db
        .insert(schema.photoSets)
        .values({
          id: generateId(),
          galleryId: gallery.id,
          title: request.body.title.trim(),
          sortIndex: nextIndex,
        })
        .returning();

      reply.code(201);
      return toSetDTO(created!, 0);
    },
  );

  app.patch<{
    Params: { id: string; setId: string };
    Body: { title?: string; visibleToClient?: boolean; allowDownloads?: boolean };
  }>(
    "/api/admin/galleries/:id/sets/:setId",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            visibleToClient: { type: "boolean" },
            allowDownloads: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const set = await findSet(request.params.id, request.params.setId);
      if (!set) return reply.code(404).send({ error: "not_found" });

      const update: Partial<typeof schema.photoSets.$inferInsert> = {};
      if (typeof request.body.title === "string") update.title = request.body.title.trim();
      if (typeof request.body.visibleToClient === "boolean") update.visibleToClient = request.body.visibleToClient;
      if (typeof request.body.allowDownloads === "boolean") update.allowDownloads = request.body.allowDownloads;

      const [updated] = await db
        .update(schema.photoSets)
        .set(update)
        .where(eq(schema.photoSets.id, set.id))
        .returning();

      const counts = await countBySet(set.galleryId);
      return toSetDTO(updated!, counts.get(set.id) ?? 0);
    },
  );

  /** Deleting a set moves its photos back to ungrouped — it never deletes
   * photos. We null set_id explicitly (not relying only on the FK action) so the
   * behavior is identical regardless of how the column was migrated. */
  app.delete<{ Params: { id: string; setId: string } }>(
    "/api/admin/galleries/:id/sets/:setId",
    async (request, reply) => {
      const set = await findSet(request.params.id, request.params.setId);
      if (!set) return reply.code(404).send({ error: "not_found" });

      const orphaned = await db
        .update(schema.photos)
        .set({ setId: null })
        .where(and(eq(schema.photos.galleryId, set.galleryId), eq(schema.photos.setId, set.id)))
        .returning({ id: schema.photos.id });

      await db.delete(schema.photoSets).where(eq(schema.photoSets.id, set.id));

      return { ok: true, ungrouped: orphaned.length };
    },
  );

  app.post<{ Params: { id: string }; Body: { orderedIds: string[] } }>(
    "/api/admin/galleries/:id/sets/reorder",
    {
      schema: {
        body: {
          type: "object",
          required: ["orderedIds"],
          properties: {
            orderedIds: { type: "array", maxItems: 500, items: { type: "string", maxLength: 64 } },
          },
        },
      },
    },
    async (request, reply) => {
      const gallery = await findGallery(request.params.id);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      // Only reorder sets that actually belong to this gallery.
      const owned = await db
        .select({ id: schema.photoSets.id })
        .from(schema.photoSets)
        .where(eq(schema.photoSets.galleryId, gallery.id));
      const ownedIds = new Set(owned.map((s) => s.id));
      const ordered = request.body.orderedIds.filter((sid) => ownedIds.has(sid));

      const reassign = db.$client.transaction(() => {
        const stmt = db.$client.prepare("UPDATE photo_sets SET sort_index = ? WHERE id = ? AND gallery_id = ?");
        ordered.forEach((sid, index) => stmt.run(index, sid, gallery.id));
      });
      reassign();

      return { ok: true, reordered: ordered.length };
    },
  );

  /** Move photos into a set (or back to ungrouped with setId=null). */
  app.post<{ Params: { id: string }; Body: { photoIds: string[]; setId: string | null } }>(
    "/api/admin/galleries/:id/photos/assign",
    {
      schema: {
        body: {
          type: "object",
          required: ["photoIds"],
          properties: {
            photoIds: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 64 } },
            setId: { type: ["string", "null"], maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: galleryId } = request.params;
      const gallery = await findGallery(galleryId);
      if (!gallery) return reply.code(404).send({ error: "not_found" });

      const setId = request.body.setId ?? null;
      if (setId !== null) {
        const set = await findSet(galleryId, setId);
        if (!set) return reply.code(400).send({ error: "invalid_set" });
      }

      const assigned = await db
        .update(schema.photos)
        .set({ setId })
        .where(and(eq(schema.photos.galleryId, galleryId), inArray(schema.photos.id, request.body.photoIds)))
        .returning({ id: schema.photos.id });

      return { assigned: assigned.length };
    },
  );
}

/** photoId → set membership counts for a gallery, keyed by setId (null = ungrouped). */
async function countBySet(galleryId: string): Promise<Map<string | null, number>> {
  const rows = await db
    .select({ setId: schema.photos.setId, count: sql<number>`count(*)` })
    .from(schema.photos)
    .where(eq(schema.photos.galleryId, galleryId))
    .groupBy(schema.photos.setId);
  return new Map(rows.map((r) => [r.setId, r.count]));
}

async function findGallery(id: string) {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}

async function findSet(galleryId: string, setId: string) {
  const [set] = await db
    .select()
    .from(schema.photoSets)
    .where(and(eq(schema.photoSets.id, setId), eq(schema.photoSets.galleryId, galleryId)))
    .limit(1);
  return set ?? null;
}
