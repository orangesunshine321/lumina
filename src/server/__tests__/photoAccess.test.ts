import { writeFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  cleanupDataDir,
  setupAdmin,
  createGallery,
  insertReadyPhoto,
  unlockGallery,
  derivedPath,
  ensurePhotoDerivedDir,
  sqlite,
  ADMIN_COOKIE,
  type App,
} from "./helpers.ts";

let app: App;
let adminCookie: string;
let gallery: { id: string; slug: string };
let photoId: string;
let galleryCookie: string;

const FILE_SIZE = 4096;
const fileBytes = Buffer.alloc(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i++) fileBytes[i] = i % 251;

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));

  gallery = await createGallery(app, adminCookie, "Guarded");
  await app.inject({
    method: "PATCH",
    url: `/api/admin/galleries/${gallery.id}`,
    payload: { password: "gallery-pass" },
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });

  const photo = await insertReadyPhoto(gallery.id);
  photoId = photo.id;
  await ensurePhotoDerivedDir(gallery.id, photoId);
  await writeFile(derivedPath(gallery.id, photoId, "thumb"), fileBytes);

  const unlocked = await unlockGallery(app, gallery.slug, gallery.id, "gallery-pass");
  galleryCookie = unlocked.cookie!;
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

function fetchThumb(cookies?: Record<string, string>, headers?: Record<string, string>) {
  return app.inject({ method: "GET", url: `/api/photos/${photoId}/thumb`, cookies, headers });
}

describe("photo byte access control", () => {
  it("denies without any credential", async () => {
    const res = await fetchThumb();
    expect(res.statusCode).toBe(403);
  });

  it("allows a valid gallery cookie", async () => {
    const res = await fetchThumb({ [`lumina_gallery_${gallery.id}`]: galleryCookie });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(FILE_SIZE);
    expect(res.headers["content-type"]).toBe("image/webp");
  });

  it("allows an admin session", async () => {
    const res = await fetchThumb({ [ADMIN_COOKIE]: adminCookie });
    expect(res.statusCode).toBe(200);
  });

  it("denies a valid cookie for a DIFFERENT gallery", async () => {
    const other = await createGallery(app, adminCookie, "Other");
    await app.inject({
      method: "PATCH",
      url: `/api/admin/galleries/${other.id}`,
      payload: { password: "other-pass" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const unlocked = await unlockGallery(app, other.slug, other.id, "other-pass");

    const res = await fetchThumb({ [`lumina_gallery_${other.id}`]: unlocked.cookie! });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown photo id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/photos/no-such-photo-id-here/thumb",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("range requests (S10)", () => {
  it("serves a suffix range as the LAST N bytes", async () => {
    const res = await fetchThumb(
      { [`lumina_gallery_${gallery.id}`]: galleryCookie },
      { range: "bytes=-100" },
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${FILE_SIZE - 100}-${FILE_SIZE - 1}/${FILE_SIZE}`);
    expect(res.rawPayload.length).toBe(100);
    expect(res.rawPayload.equals(fileBytes.subarray(FILE_SIZE - 100))).toBe(true);
  });

  it("416s an unsatisfiable range", async () => {
    const res = await fetchThumb(
      { [`lumina_gallery_${gallery.id}`]: galleryCookie },
      { range: "bytes=999999-" },
    );
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${FILE_SIZE}`);
  });

  it("serves an ordinary bounded range", async () => {
    const res = await fetchThumb(
      { [`lumina_gallery_${gallery.id}`]: galleryCookie },
      { range: "bytes=100-199" },
    );
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.equals(fileBytes.subarray(100, 200))).toBe(true);
  });
});
