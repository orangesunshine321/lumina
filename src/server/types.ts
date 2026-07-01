import "fastify";
import type { schema } from "./db/client.ts";
import type { InferSelectModel } from "drizzle-orm";

export type AdminSessionRow = InferSelectModel<typeof schema.adminSessions>;
export type GalleryRow = InferSelectModel<typeof schema.galleries>;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the requireAdmin preHandler once the admin session cookie is verified. */
    adminSession?: AdminSessionRow;
    /** Set by the requireGalleryAccess preHandler for every /api/gallery/:slug/* and photo-byte route. */
    gallery?: GalleryRow;
    /** The long-lived anonymous browser identity used only to attribute favorite-toggle provenance. */
    clientToken?: string;
  }
}
