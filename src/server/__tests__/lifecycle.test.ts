import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE,
  cleanupDataDir,
  createApp,
  createGallery,
  db,
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

function patch(id: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/admin/galleries/${id}`,
    payload: body,
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
}

function list(query = "") {
  return app.inject({
    method: "GET",
    url: `/api/admin/galleries${query}`,
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
}

describe("gallery archive & search", () => {
  it("hides archived galleries from the default list, shows them with archived=1", async () => {
    const keep = await createGallery(app, adminCookie, "Active Shoot");
    const old = await createGallery(app, adminCookie, "Old Shoot");

    const archived = await patch(old.id, { archived: true });
    expect(archived.json().archivedAt).not.toBeNull();

    const def = await list();
    const ids = def.json().galleries.map((g: { id: string }) => g.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(old.id);

    const all = await list("?archived=1");
    expect(all.json().galleries.map((g: { id: string }) => g.id)).toContain(old.id);

    // Unarchive restores it to the default list.
    const restored = await patch(old.id, { archived: false });
    expect(restored.json().archivedAt).toBeNull();
    const def2 = await list();
    expect(def2.json().galleries.map((g: { id: string }) => g.id)).toContain(old.id);
  });

  it("filters by title search, treating % and _ as literals", async () => {
    await createGallery(app, adminCookie, "Beach Wedding");
    await createGallery(app, adminCookie, "Studio Portraits");

    const beach = await list("?search=wedding");
    const titles = beach.json().galleries.map((g: { title: string }) => g.title);
    expect(titles).toContain("Beach Wedding");
    expect(titles).not.toContain("Studio Portraits");

    // A wildcard char in the query shouldn't match everything.
    const wild = await list("?search=%25");
    expect(wild.json().galleries).toHaveLength(0);
  });
});

describe("gallery expiry", () => {
  it("sets and clears an expiry date", async () => {
    const gallery = await createGallery(app, adminCookie, "Expiring");
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const set = await patch(gallery.id, { expiresAt: future });
    expect(set.json().expiresAt).not.toBeNull();

    const clear = await patch(gallery.id, { expiresAt: null });
    expect(clear.json().expiresAt).toBeNull();

    const bad = await patch(gallery.id, { expiresAt: "not-a-date" });
    expect(bad.statusCode).toBe(400);
  });

  it("blocks public access to an expired gallery but keeps admin access", async () => {
    const gallery = await createGallery(app, adminCookie, "Past");
    // Expire it directly in the past.
    await db
      .update(schema.galleries)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.galleries.id, gallery.id));
    await db
      .insert(schema.photos)
      .values({
        id: "photo-expired-1",
        galleryId: gallery.id,
        originalFilename: "DSC_1.jpg",
        baseFilename: "DSC_1",
        fileExt: "jpg",
        byteSize: 100,
        checksumSha256: "sum-expired",
        status: "ready",
        sortIndex: 0,
      });

    // Landing metadata reports expired.
    const meta = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().expired).toBe(true);
    expect(meta.json().hasAccess).toBe(false);

    // Client photo list is gone.
    const photos = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/photos` });
    expect(photos.statusCode).toBe(410);

    // Photo bytes: blocked for the public, allowed for the admin.
    const publicBytes = await app.inject({ method: "GET", url: `/api/photos/photo-expired-1/thumb` });
    expect(publicBytes.statusCode).toBe(403);
    const adminBytes = await app.inject({
      method: "GET",
      url: `/api/photos/photo-expired-1/original`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    // Admin passes the access check (404 only because no file on disk, not 403).
    expect(adminBytes.statusCode).not.toBe(403);
  });
});
