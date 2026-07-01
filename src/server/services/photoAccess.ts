import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { galleryAccessCookieName, verifyGalleryAccessToken } from "./auth.ts";
import { ensureClientToken } from "../lib/http.ts";
import type { GalleryRow } from "../types.ts";

export async function resolveGalleryBySlug(slug: string): Promise<GalleryRow | null> {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.slug, slug)).limit(1);
  return gallery ?? null;
}

export async function resolveGalleryById(id: string): Promise<GalleryRow | null> {
  const [gallery] = await db.select().from(schema.galleries).where(eq(schema.galleries.id, id)).limit(1);
  return gallery ?? null;
}

export async function hasValidGalleryCookie(
  request: FastifyRequest,
  gallery: GalleryRow,
): Promise<boolean> {
  const cookie = request.cookies[galleryAccessCookieName(gallery.id)];
  const payload = await verifyGalleryAccessToken(cookie);
  return Boolean(payload && payload.galleryId === gallery.id && payload.passwordVersion === gallery.passwordVersion);
}

/** True if this gallery is currently viewable by the caller: either it has no
 * password at all, or the caller presented a valid, still-current-version
 * access cookie for it. */
export async function hasGalleryAccess(request: FastifyRequest, gallery: GalleryRow): Promise<boolean> {
  if (!gallery.passwordHash) return true;
  return hasValidGalleryCookie(request, gallery);
}

/**
 * preHandler for every /api/gallery/:slug/* route that requires the caller to
 * have already passed the password gate (photo listing, favoriting). Resolves
 * the gallery, ensures a client_token cookie exists, and enforces the
 * password gate — attaching the resolved row to request.gallery on success.
 *
 * NOT used by the /unlock (password submission) route itself, which needs
 * identical-response-shape anti-enumeration handling instead (see
 * routes/gallery/public.ts) — or by the landing metadata route, which
 * intentionally reveals whether a password is required so the client can
 * render the right form.
 */
export async function requireGalleryAccess(request: FastifyRequest, reply: FastifyReply) {
  const { slug } = request.params as { slug: string };
  const gallery = await resolveGalleryBySlug(slug);
  if (!gallery) {
    return reply.code(404).send({ error: "not_found" });
  }

  ensureClientToken(request, reply);

  if (!(await hasGalleryAccess(request, gallery))) {
    return reply.code(401).send({ error: "password_required" });
  }

  request.gallery = gallery;
}
