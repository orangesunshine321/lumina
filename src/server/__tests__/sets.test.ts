import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

let app: App;
let adminCookie: string;
let collectZipEntries: typeof import("../services/zip.ts")["collectZipEntries"];

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
  ({ collectZipEntries } = await import("../services/zip.ts"));
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

function admin(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as never, cookies: { [ADMIN_COOKIE]: adminCookie } });
}

async function createSet(galleryId: string, title: string): Promise<{ id: string }> {
  const res = await admin("POST", `/api/admin/galleries/${galleryId}/sets`, { title });
  if (res.statusCode !== 201) throw new Error(`createSet failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

async function insertPhotoWithFile(galleryId: string, overrides: Record<string, unknown> = {}) {
  const photo = await insertReadyPhoto(galleryId, overrides);
  const path = originalPath(galleryId, photo.id, photo.fileExt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(`jpeg-${photo.id}`));
  return photo;
}

describe("photo sets — admin CRUD", () => {
  it("creates, lists with counts, updates, reorders, and deletes (orphaning photos)", async () => {
    const gallery = await createGallery(app, adminCookie, "Sets CRUD");
    await insertReadyPhoto(gallery.id); // one ungrouped photo

    const a = await createSet(gallery.id, "Raws");
    const b = await createSet(gallery.id, "Finals");

    // Assign a fresh photo into Raws.
    const p = await insertReadyPhoto(gallery.id);
    const assign = await admin("POST", `/api/admin/galleries/${gallery.id}/photos/assign`, {
      photoIds: [p.id],
      setId: a.id,
    });
    expect(assign.json().assigned).toBe(1);

    const list = await admin("GET", `/api/admin/galleries/${gallery.id}/sets`);
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.sets.map((s: { title: string }) => s.title)).toEqual(["Raws", "Finals"]);
    expect(body.sets.find((s: { id: string }) => s.id === a.id).photoCount).toBe(1);
    expect(body.ungroupedCount).toBe(1);

    // Toggle visibility + downloads on Raws.
    const patch = await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${a.id}`, {
      visibleToClient: false,
      allowDownloads: true,
    });
    expect(patch.json().visibleToClient).toBe(false);
    expect(patch.json().allowDownloads).toBe(true);

    // Reorder: Finals first.
    await admin("POST", `/api/admin/galleries/${gallery.id}/sets/reorder`, { orderedIds: [b.id, a.id] });
    const reordered = await admin("GET", `/api/admin/galleries/${gallery.id}/sets`);
    expect(reordered.json().sets.map((s: { title: string }) => s.title)).toEqual(["Finals", "Raws"]);

    // Delete Raws → its photo is orphaned back to ungrouped, not deleted.
    const del = await admin("DELETE", `/api/admin/galleries/${gallery.id}/sets/${a.id}`);
    expect(del.json().ungrouped).toBe(1);
    const [survivor] = await db
      .select({ id: schema.photos.id, setId: schema.photos.setId })
      .from(schema.photos)
      .where(eq(schema.photos.id, p.id));
    expect(survivor!.setId).toBeNull(); // photo survived, just ungrouped

    const after = await admin("GET", `/api/admin/galleries/${gallery.id}/sets`);
    expect(after.json().sets).toHaveLength(1);
    expect(after.json().ungroupedCount).toBe(2);
  });

  it("rejects assigning to a set from another gallery", async () => {
    const g1 = await createGallery(app, adminCookie, "G1");
    const g2 = await createGallery(app, adminCookie, "G2");
    const setInG2 = await createSet(g2.id, "Other");
    const p = await insertReadyPhoto(g1.id);
    const res = await admin("POST", `/api/admin/galleries/${g1.id}/photos/assign`, {
      photoIds: [p.id],
      setId: setInG2.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_set");
  });
});

describe("photo sets — client visibility", () => {
  it("hides non-visible sets from the client everywhere", async () => {
    const gallery = await createGallery(app, adminCookie, "Visibility");
    const hidden = await createSet(gallery.id, "Hidden");
    const shown = await createSet(gallery.id, "Shown");
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${hidden.id}`, { visibleToClient: false });

    const h = await insertPhotoWithFile(gallery.id, { setId: hidden.id });
    const s = await insertReadyPhoto(gallery.id, { setId: shown.id });
    const u = await insertReadyPhoto(gallery.id); // ungrouped

    // Landing: photoCount counts only visible (shown + ungrouped); hidden set absent.
    const landing = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    const meta = landing.json();
    expect(meta.photoCount).toBe(2);
    expect(meta.ungroupedCount).toBe(1);
    expect(meta.sets.map((x: { title: string }) => x.title)).toEqual(["Shown"]);

    // Photo list excludes the hidden set's photo.
    const listRes = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/photos` });
    const ids = listRes.json().photos.map((x: { id: string }) => x.id);
    expect(ids).toContain(s.id);
    expect(ids).toContain(u.id);
    expect(ids).not.toContain(h.id);

    // Filtering to the hidden set returns nothing; to the shown set returns its photo.
    const hiddenList = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/photos?setId=${hidden.id}` });
    expect(hiddenList.json().photos).toHaveLength(0);
    const shownList = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/photos?setId=${shown.id}` });
    expect(shownList.json().photos.map((x: { id: string }) => x.id)).toEqual([s.id]);

    // Favoriting a hidden-set photo is a 404; a visible one works.
    const favHidden = await app.inject({ method: "POST", url: `/api/gallery/${gallery.slug}/photos/${h.id}/favorite` });
    expect(favHidden.statusCode).toBe(404);
    const favShown = await app.inject({ method: "POST", url: `/api/gallery/${gallery.slug}/photos/${s.id}/favorite` });
    expect(favShown.statusCode).toBe(200);

    // Serving a hidden-set photo to a non-admin is a 404 (visibility gate fires
    // before any file access).
    const serveHidden = await app.inject({ method: "GET", url: `/api/photos/${h.id}/thumb` });
    expect(serveHidden.statusCode).toBe(404);
    expect(serveHidden.json().error).toBe("not_found");
    // Admin bypasses the visibility gate and gets the original bytes (200).
    const serveAdmin = await app.inject({
      method: "GET",
      url: `/api/photos/${h.id}/original`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(serveAdmin.statusCode).toBe(200);
  });
});

describe("photo sets — download selection & permissions", () => {
  it("collectZipEntries applies visibility + per-set download rules", async () => {
    const gallery = await createGallery(app, adminCookie, "Downloads Matrix");
    const raws = await createSet(gallery.id, "Raws"); // visible, NOT downloadable
    const finals = await createSet(gallery.id, "Finals");
    const hidden = await createSet(gallery.id, "Hidden");
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${finals.id}`, { allowDownloads: true });
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${hidden.id}`, {
      visibleToClient: false,
      allowDownloads: true,
    });

    const r = await insertReadyPhoto(gallery.id, { setId: raws.id });
    const f = await insertReadyPhoto(gallery.id, { setId: finals.id });
    const hid = await insertReadyPhoto(gallery.id, { setId: hidden.id });
    const u = await insertReadyPhoto(gallery.id); // ungrouped

    const ids = (entries: { photoId: string }[]) => new Set(entries.map((e) => e.photoId));

    // Admin "all": everything.
    const adminAll = await collectZipEntries({ galleryId: gallery.id, scope: "all", folderBySet: true });
    expect(ids(adminAll)).toEqual(new Set([r.id, f.id, hid.id, u.id]));

    // Client downloadable, gallery downloads OFF → only the visible+downloadable set (Finals).
    const clientOff = await collectZipEntries({
      galleryId: gallery.id,
      scope: "all",
      visibleOnly: true,
      downloadableOnly: true,
      galleryAllowDownloads: false,
      folderBySet: true,
    });
    expect(ids(clientOff)).toEqual(new Set([f.id]));

    // Gallery downloads ON → ungrouped becomes downloadable too.
    const clientOn = await collectZipEntries({
      galleryId: gallery.id,
      scope: "all",
      visibleOnly: true,
      downloadableOnly: true,
      galleryAllowDownloads: true,
      folderBySet: true,
    });
    expect(ids(clientOn)).toEqual(new Set([f.id, u.id]));

    // Favorites respect download permission: favorite r (not downloadable) and f.
    await app.inject({ method: "POST", url: `/api/gallery/${gallery.slug}/photos/${r.id}/favorite` });
    await app.inject({ method: "POST", url: `/api/gallery/${gallery.slug}/photos/${f.id}/favorite` });
    const favDownloadable = await collectZipEntries({
      galleryId: gallery.id,
      scope: "favorites",
      visibleOnly: true,
      downloadableOnly: true,
      galleryAllowDownloads: false,
    });
    expect(ids(favDownloadable)).toEqual(new Set([f.id])); // r excluded (its set isn't downloadable)
  });

  it("gates the client download route by set permission", async () => {
    const gallery = await createGallery(app, adminCookie, "Route Gate");
    const raws = await createSet(gallery.id, "Raws"); // not downloadable
    const finals = await createSet(gallery.id, "Finals");
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${finals.id}`, { allowDownloads: true });
    await insertPhotoWithFile(gallery.id, { setId: raws.id });
    await insertPhotoWithFile(gallery.id, { setId: finals.id });

    // A non-downloadable set → 403.
    const rawsZip = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/download?scope=set&setId=${raws.id}` });
    expect(rawsZip.statusCode).toBe(403);

    // The downloadable set → streams a zip.
    const finalsZip = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/download?scope=set&setId=${finals.id}` });
    expect(finalsZip.statusCode).toBe(200);
    expect(finalsZip.headers["content-type"]).toBe("application/zip");

    // Admin gets the raws set regardless of the client toggle.
    const adminRaws = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}/download?scope=set&setId=${raws.id}`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(adminRaws.statusCode).toBe(200);
  });

  it("returns 403 when nothing in the gallery is downloadable", async () => {
    const gallery = await createGallery(app, adminCookie, "Nothing");
    await insertPhotoWithFile(gallery.id);
    const res = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/download` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("downloads_disabled");
  });
});

describe("photo sets — client count/cover consistency", () => {
  async function favorite(slug: string, photoId: string) {
    return app.inject({ method: "POST", url: `/api/gallery/${slug}/photos/${photoId}/favorite` });
  }

  it("hides the cover photo id when the cover is in a hidden set", async () => {
    const gallery = await createGallery(app, adminCookie, "Hidden Cover");
    const set = await createSet(gallery.id, "Set");
    const p = await insertReadyPhoto(gallery.id, { setId: set.id });
    // Set it as the gallery cover while the set is still visible.
    const patchCover = await admin("PATCH", `/api/admin/galleries/${gallery.id}`, { coverPhotoId: p.id });
    expect(patchCover.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` })).json().coverPhotoId).toBe(p.id);

    // Hide the set → the cover must no longer be exposed to the client.
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${set.id}`, { visibleToClient: false });
    expect((await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` })).json().coverPhotoId).toBeNull();
  });

  it("reports downloadableFavoriteCount per set download permission", async () => {
    const gallery = await createGallery(app, adminCookie, "Downloadable Favs");
    const finals = await createSet(gallery.id, "Finals");
    const raws = await createSet(gallery.id, "Raws");
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${finals.id}`, { allowDownloads: true });

    const f = await insertReadyPhoto(gallery.id, { setId: finals.id });
    const r = await insertReadyPhoto(gallery.id, { setId: raws.id });
    const u = await insertReadyPhoto(gallery.id); // ungrouped
    await favorite(gallery.slug, f.id);
    await favorite(gallery.slug, r.id);
    await favorite(gallery.slug, u.id);

    // Gallery downloads OFF → only the Finals favorite is downloadable.
    let meta = (await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` })).json();
    expect(meta.favoriteCount).toBe(3); // all visible
    expect(meta.downloadableFavoriteCount).toBe(1);

    // Gallery downloads ON → the ungrouped favorite becomes downloadable too.
    await admin("PATCH", `/api/admin/galleries/${gallery.id}`, { allowDownloads: true });
    meta = (await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` })).json();
    expect(meta.downloadableFavoriteCount).toBe(2);
  });

  it("excludes hidden-set favorites from the submit count (matches landing)", async () => {
    const gallery = await createGallery(app, adminCookie, "Submit Count");
    const set = await createSet(gallery.id, "S");
    const p = await insertReadyPhoto(gallery.id, { setId: set.id });
    await favorite(gallery.slug, p.id);

    // Hide the set after the pick was made.
    await admin("PATCH", `/api/admin/galleries/${gallery.id}/sets/${set.id}`, { visibleToClient: false });

    const landing = (await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` })).json();
    expect(landing.favoriteCount).toBe(0);
    const submit = await app.inject({ method: "POST", url: `/api/gallery/${gallery.slug}/submit`, payload: {} });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().favoriteCount).toBe(0); // not 1
  });
});

// Local import to avoid pulling drizzle's `eq` into the top-level helper import list.
import { eq } from "drizzle-orm";
