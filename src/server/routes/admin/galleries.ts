import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
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
  createdAt: string;
  updatedAt: string;
}

function toDTO(row: typeof schema.galleries.$inferSelect): GalleryDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    hasPassword: Boolean(row.passwordHash),
    coverPhotoId: row.coverPhotoId,
    photoCount: row.photoCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
      return toDTO(created!);
    },
  );

  app.get("/api/admin/galleries", async () => {
    const rows = await db.select().from(schema.galleries).orderBy(desc(schema.galleries.createdAt));
    return { galleries: rows.map(toDTO) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/galleries/:id", async (request, reply) => {
    const gallery = await findGallery(request.params.id);
    if (!gallery) return reply.code(404).send({ error: "not_found" });
    return toDTO(gallery);
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; password?: string | null } }>(
    "/api/admin/galleries/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            password: { type: ["string", "null"], maxLength: 512 },
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

      return toDTO(updated!);
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
