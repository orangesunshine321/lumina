import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  cleanupDataDir,
  cookieValue,
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

async function insertPhotoWithFile(galleryId: string, overrides = {}) {
  const photo = await insertReadyPhoto(galleryId, overrides);
  const path = originalPath(galleryId, photo.id, photo.fileExt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(`jpeg-bytes-${photo.id}`));
  return photo;
}

describe("client downloads (opt-in per gallery)", () => {
  it("gates zips and originals behind the allowDownloads toggle", async () => {
    const gallery = await createGallery(app, adminCookie, "Downloads");
    const photo = await insertPhotoWithFile(gallery.id);

    // Disabled (the default): zip 403, client original 403; admin still 200.
    const zipOff = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/download` });
    expect(zipOff.statusCode).toBe(403);
    expect(zipOff.json().error).toBe("downloads_disabled");
    const origOff = await app.inject({ method: "GET", url: `/api/photos/${photo.id}/original` });
    expect(origOff.statusCode).toBe(403);
    const adminOrig = await app.inject({
      method: "GET",
      url: `/api/photos/${photo.id}/original`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(adminOrig.statusCode).toBe(200);

    // Enabled: client zip streams, per-photo download gets an attachment name.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${gallery.id}`,
      payload: { allowDownloads: true },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(patch.json().allowDownloads).toBe(true);

    const zipOn = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}/download` });
    expect(zipOn.statusCode).toBe(200);
    expect(zipOn.headers["content-type"]).toBe("application/zip");

    const download = await app.inject({
      method: "GET",
      url: `/api/photos/${photo.id}/original?download=1`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain(photo.originalFilename);

    const noFavs = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/download?scope=favorites`,
    });
    expect(noFavs.statusCode).toBe(400);
    expect(noFavs.json().error).toBe("no_favorites");
  });

  it("exposes allowDownloads and coverPhotoId in public meta only with access", async () => {
    const gallery = await createGallery(app, adminCookie, "Meta Gate");
    const photo = await insertPhotoWithFile(gallery.id);
    await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${gallery.id}`,
      payload: { allowDownloads: true, coverPhotoId: photo.id },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });

    const open = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(open.json().allowDownloads).toBe(true);
    expect(open.json().coverPhotoId).toBe(photo.id);

    // Lock it: past-the-gate fields must disappear for cookieless visitors.
    await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${gallery.id}`,
      payload: { password: "gate-password-123" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const locked = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(locked.json().hasAccess).toBe(false);
    expect(locked.json().allowDownloads).toBe(false);
    expect(locked.json().coverPhotoId).toBeNull();
  });
});

describe("admin account management", () => {
  it("changes the password, revokes other sessions, and rejects a wrong current password", async () => {
    // A second signed-in device.
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const otherCookie = cookieValue(otherLogin, ADMIN_COOKIE)!;

    const wrong = await app.inject({
      method: "POST",
      url: "/api/admin/account/password",
      payload: { currentPassword: "not-the-password", newPassword: "a-brand-new-password-1" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("wrong_password");

    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/account/password",
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: "a-brand-new-password-1" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(ok.statusCode).toBe(200);

    // The changing session survives; the other device is signed out.
    const meSelf = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(meSelf.statusCode).toBe(200);
    const meOther = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: otherCookie },
    });
    expect(meOther.statusCode).toBe(401);

    // Old password no longer logs in; the new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: "a-brand-new-password-1" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("changes email with password confirmation and signs out everywhere on request", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: "a-brand-new-password-1" },
    });
    const cookie = cookieValue(login, ADMIN_COOKIE)!;

    const email = await app.inject({
      method: "POST",
      url: "/api/admin/account/email",
      payload: { password: "a-brand-new-password-1", email: "New@Example.Dev" },
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(email.statusCode).toBe(200);
    expect(email.json().email).toBe("new@example.dev");

    const logoutAll = await app.inject({
      method: "POST",
      url: "/api/admin/account/logout-all",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(logoutAll.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(me.statusCode).toBe(401);

    // Restore a session for the remaining tests.
    const relogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: "new@example.dev", password: "a-brand-new-password-1" },
    });
    adminCookie = cookieValue(relogin, ADMIN_COOKIE)!;
  });
});

describe("link regeneration and photo reordering", () => {
  it("regenerates the slug and kills the old link immediately", async () => {
    const gallery = await createGallery(app, adminCookie, "Regen");
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/regenerate-slug`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const newSlug = res.json().slug;
    expect(newSlug).not.toBe(gallery.slug);

    const oldMeta = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(oldMeta.statusCode).toBe(404);
    const newMeta = await app.inject({ method: "GET", url: `/api/gallery/${newSlug}` });
    expect(newMeta.statusCode).toBe(200);
  });

  it("reorders by capture time (EXIF-less photos last) and back by filename", async () => {
    const gallery = await createGallery(app, adminCookie, "Reorder");
    // Filename order A,B,C — capture order C,B,A; D has no EXIF time.
    const a = await insertReadyPhoto(gallery.id, { baseFilename: "AAA_1", capturedAt: new Date("2026-01-03") });
    const b = await insertReadyPhoto(gallery.id, { baseFilename: "BBB_1", capturedAt: new Date("2026-01-02") });
    const c = await insertReadyPhoto(gallery.id, { baseFilename: "CCC_1", capturedAt: new Date("2026-01-01") });
    const d = await insertReadyPhoto(gallery.id, { baseFilename: "DDD_1", capturedAt: null });

    const byCapture = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/reorder`,
      payload: { by: "capturedAt" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(byCapture.json()).toEqual({ ok: true, reordered: 4 });

    const listAfterCapture = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}/photos`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(listAfterCapture.json().photos.map((p: { id: string }) => p.id)).toEqual([
      c.id,
      b.id,
      a.id,
      d.id,
    ]);

    await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/reorder`,
      payload: { by: "filename" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const listAfterFilename = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}/photos`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(listAfterFilename.json().photos.map((p: { id: string }) => p.id)).toEqual([
      a.id,
      b.id,
      c.id,
      d.id,
    ]);
  });
});

describe("backup operations and gallery insights", () => {
  it("runs a backup on demand and streams the newest snapshot", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/admin/backup/run",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().lastBackupAt).not.toBeNull();
    expect(run.json().isStale).toBe(false);

    const download = await app.inject({
      method: "GET",
      url: "/api/admin/backup/download",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("lumina-app-");
    expect(download.rawPayload.length).toBeGreaterThan(0);
  });

  it("reports statusCounts on the gallery detail and lastFavoriteAt on the list", async () => {
    const gallery = await createGallery(app, adminCookie, "Insights");
    const ready = await insertReadyPhoto(gallery.id);
    await insertReadyPhoto(gallery.id, { status: "pending" });
    await insertReadyPhoto(gallery.id, { status: "failed" });
    await db.insert(schema.favorites).values({
      galleryId: gallery.id,
      photoId: ready.id,
      toggledByClientToken: "client-x",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(detail.json().statusCounts).toEqual({ pending: 1, processing: 0, failed: 1 });

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/galleries",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const entry = list.json().galleries.find((g: { id: string }) => g.id === gallery.id);
    expect(entry.lastFavoriteAt).not.toBeNull();
  });
});
