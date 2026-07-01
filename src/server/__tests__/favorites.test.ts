import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createApp,
  cleanupDataDir,
  setupAdmin,
  createGallery,
  insertReadyPhoto,
  db,
  schema,
  sqlite,
  ADMIN_COOKIE,
  type App,
} from "./helpers.ts";

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

describe("favorites", () => {
  it("toggles on and off", async () => {
    const gallery = await createGallery(app, adminCookie);
    const photo = await insertReadyPhoto(gallery.id);
    const url = `/api/gallery/${gallery.slug}/photos/${photo.id}/favorite`;

    const on = await app.inject({ method: "POST", url });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ favorited: true });

    const off = await app.inject({ method: "POST", url });
    expect(off.json()).toEqual({ favorited: false });
  });

  it("concurrent double-tap never 500s (S11)", async () => {
    const gallery = await createGallery(app, adminCookie);
    const photo = await insertReadyPhoto(gallery.id);
    const url = `/api/gallery/${gallery.slug}/photos/${photo.id}/favorite`;

    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url }),
      app.inject({ method: "POST", url }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.favorites)
      .where(and(eq(schema.favorites.galleryId, gallery.id), eq(schema.favorites.photoId, photo.id)));
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("rejects a photoId belonging to a different gallery", async () => {
    const galleryA = await createGallery(app, adminCookie, "A");
    const galleryB = await createGallery(app, adminCookie, "B");
    const photoInA = await insertReadyPhoto(galleryA.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/gallery/${galleryB.slug}/photos/${photoInA.id}/favorite`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("lightroom list", () => {
  it("exports favorited ready photos, extension-stripped, in sortIndex order", async () => {
    const gallery = await createGallery(app, adminCookie, "Export");
    const p1 = await insertReadyPhoto(gallery.id, {
      baseFilename: "DSC_0010",
      originalFilename: "DSC_0010.jpg",
      sortIndex: 0,
    });
    await insertReadyPhoto(gallery.id, {
      baseFilename: "DSC_0002",
      originalFilename: "DSC_0002.jpg",
      sortIndex: 1,
    });
    const p3 = await insertReadyPhoto(gallery.id, {
      baseFilename: "DSC_0030",
      originalFilename: "DSC_0030.jpg",
      sortIndex: 2,
    });
    // Favorited but still processing — must be excluded from the export.
    const pending = await insertReadyPhoto(gallery.id, {
      baseFilename: "DSC_9999",
      originalFilename: "DSC_9999.jpg",
      sortIndex: 3,
      status: "pending",
    });

    for (const photo of [p1, p3, pending]) {
      await db.insert(schema.favorites).values({
        galleryId: gallery.id,
        photoId: photo.id,
        toggledByClientToken: "test-client",
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}/lightroom-list`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      count: 2,
      filenames: ["DSC_0010", "DSC_0030"],
      text: "DSC_0010, DSC_0030",
    });
  });
});
