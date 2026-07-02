import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ADMIN_COOKIE,
  cleanupDataDir,
  createApp,
  createGallery,
  db,
  insertReadyPhoto,
  originalPath,
  schema,
  setupAdmin,
  sqlite,
  type App,
} from "./helpers.ts";
import { eq } from "drizzle-orm";

let app: App;
let adminCookie: string;

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

describe("photo management", () => {
  it("bulk-deletes photos, recounts, reassigns the cover, and removes files", async () => {
    const gallery = await createGallery(app, adminCookie, "Delete Test");
    const p1 = await insertReadyPhoto(gallery.id);
    const p2 = await insertReadyPhoto(gallery.id);
    const p3 = await insertReadyPhoto(gallery.id);
    await db
      .update(schema.galleries)
      .set({ photoCount: 3, coverPhotoId: p1.id })
      .where(eq(schema.galleries.id, gallery.id));

    // A real original on disk for p1, to prove disk cleanup happens.
    const p1Path = originalPath(gallery.id, p1.id, p1.fileExt);
    await mkdir(dirname(p1Path), { recursive: true });
    await writeFile(p1Path, Buffer.from("jpeg-bytes"));

    // Foreign id (another gallery's photo) must be ignored, not deleted.
    const otherGallery = await createGallery(app, adminCookie, "Other");
    const foreign = await insertReadyPhoto(otherGallery.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/photos/delete`,
      payload: { photoIds: [p1.id, p2.id, foreign.id] },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const body = detail.json();
    expect(body.photoCount).toBe(1);
    expect(body.coverPhotoId).toBe(p3.id); // old cover deleted → first remaining ready photo

    expect(existsSync(p1Path)).toBe(false);
    const [foreignRow] = await db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.id, foreign.id));
    expect(foreignRow).toBeDefined();
  });

  it("retries a failed photo and rejects retrying a ready one", async () => {
    const gallery = await createGallery(app, adminCookie, "Retry Test");
    const failed = await insertReadyPhoto(gallery.id, { status: "failed", attempts: 5, lastError: "boom" });
    const ready = await insertReadyPhoto(gallery.id);

    const ok = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/photos/${failed.id}/retry`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(ok.statusCode).toBe(200);
    const [row] = await db.select().from(schema.photos).where(eq(schema.photos.id, failed.id));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();

    const bad = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/photos/${ready.id}/retry`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(bad.statusCode).toBe(404);
  });

  it("sets a cover photo via PATCH and rejects photos from other galleries", async () => {
    const gallery = await createGallery(app, adminCookie, "Cover Test");
    const photo = await insertReadyPhoto(gallery.id);
    const otherGallery = await createGallery(app, adminCookie, "Cover Other");
    const foreign = await insertReadyPhoto(otherGallery.id);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${gallery.id}`,
      payload: { coverPhotoId: photo.id },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().coverPhotoId).toBe(photo.id);

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${gallery.id}`,
      payload: { coverPhotoId: foreign.id },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_cover_photo");
  });
});

describe("system stats", () => {
  it("reports version, library totals, and queue counts", async () => {
    const gallery = await createGallery(app, adminCookie, "Stats Test");
    await insertReadyPhoto(gallery.id, { status: "pending" });
    await insertReadyPhoto(gallery.id, { status: "failed" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/system",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(stats.library.galleries).toBeGreaterThanOrEqual(1);
    expect(stats.library.photos).toBeGreaterThanOrEqual(2);
    expect(stats.library.originalsBytes).toBeGreaterThan(0);
    expect(stats.database.sizeBytes).toBeGreaterThan(0);
    expect(stats.queue.pending).toBeGreaterThanOrEqual(1);
    expect(stats.queue.failed).toBeGreaterThanOrEqual(1);
    expect(stats.backup).toHaveProperty("isStale");
  });

  it("requires admin auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/system" });
    expect(res.statusCode).toBe(401);
  });
});

describe("client favorites filter and public counts", () => {
  it("filters to favorited photos and reports counts past the gate", async () => {
    const gallery = await createGallery(app, adminCookie, "Filter Test");
    const p1 = await insertReadyPhoto(gallery.id);
    await insertReadyPhoto(gallery.id);
    await insertReadyPhoto(gallery.id, { status: "pending" }); // must not count as ready
    await db.insert(schema.favorites).values({
      galleryId: gallery.id,
      photoId: p1.id,
      toggledByClientToken: "test-client",
    });

    const meta = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().photoCount).toBe(2); // ready photos only
    expect(meta.json().favoriteCount).toBe(1);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/photos?favorites=1`,
    });
    expect(filtered.statusCode).toBe(200);
    const { photos } = filtered.json();
    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe(p1.id);
    expect(photos[0].favorited).toBe(true);

    const all = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/photos` });
    expect(all.json().photos).toHaveLength(2);
  });

  it("includes favoriteCount in admin gallery DTOs", async () => {
    const gallery = await createGallery(app, adminCookie, "FavCount Test");
    const p1 = await insertReadyPhoto(gallery.id);
    await db.insert(schema.favorites).values({
      galleryId: gallery.id,
      photoId: p1.id,
      toggledByClientToken: "test-client",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/galleries",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const found = list.json().galleries.find((g: { id: string }) => g.id === gallery.id);
    expect(found.favoriteCount).toBe(1);
  });
});
