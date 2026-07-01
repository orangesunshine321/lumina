import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  cleanupDataDir,
  setupAdmin,
  createGallery,
  unlockGallery,
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

function adminInject(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as never, cookies: { [ADMIN_COOKIE]: adminCookie } });
}

describe("gallery CRUD + password lifecycle", () => {
  it("creates, lists, gets, and renames a gallery", async () => {
    const gallery = await createGallery(app, adminCookie, "Spring Shoot");
    expect(gallery.slug).toHaveLength(21);

    const list = await adminInject("GET", "/api/admin/galleries");
    expect(list.json().galleries.some((g: { id: string }) => g.id === gallery.id)).toBe(true);

    const got = await adminInject("GET", `/api/admin/galleries/${gallery.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().title).toBe("Spring Shoot");

    const patched = await adminInject("PATCH", `/api/admin/galleries/${gallery.id}`, {
      title: "Renamed Shoot",
    });
    expect(patched.json().title).toBe("Renamed Shoot");
  });

  it("password set/change/removal invalidates previously issued gallery cookies", async () => {
    const gallery = await createGallery(app, adminCookie, "Locked");

    let res = await adminInject("PATCH", `/api/admin/galleries/${gallery.id}`, {
      password: "first-password",
    });
    expect(res.json().hasPassword).toBe(true);

    const first = await unlockGallery(app, gallery.slug, gallery.id, "first-password");
    expect(first.res.statusCode).toBe(200);
    expect(first.cookie).toBeTruthy();

    const photosWithCookie = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/photos`,
      cookies: { [`pixset_gallery_${gallery.id}`]: first.cookie! },
    });
    expect(photosWithCookie.statusCode).toBe(200);

    // Change the password — the old cookie's passwordVersion no longer matches.
    await adminInject("PATCH", `/api/admin/galleries/${gallery.id}`, { password: "second-password" });
    const staleCookie = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/photos`,
      cookies: { [`pixset_gallery_${gallery.id}`]: first.cookie! },
    });
    expect(staleCookie.statusCode).toBe(401);

    const second = await unlockGallery(app, gallery.slug, gallery.id, "second-password");
    expect(second.res.statusCode).toBe(200);

    // Remove the password entirely: the gallery becomes public again.
    res = await adminInject("PATCH", `/api/admin/galleries/${gallery.id}`, { password: null });
    expect(res.json().hasPassword).toBe(false);
    const publicAccess = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/photos`,
    });
    expect(publicAccess.statusCode).toBe(200);
  });

  it("deletes a gallery", async () => {
    const gallery = await createGallery(app, adminCookie, "Doomed");
    const del = await adminInject("DELETE", `/api/admin/galleries/${gallery.id}`);
    expect(del.statusCode).toBe(200);
    const got = await adminInject("GET", `/api/admin/galleries/${gallery.id}`);
    expect(got.statusCode).toBe(404);
  });
});

describe("unlock anti-enumeration", () => {
  it("wrong password and nonexistent slug are indistinguishable", async () => {
    const gallery = await createGallery(app, adminCookie, "Secret");
    await adminInject("PATCH", `/api/admin/galleries/${gallery.id}`, { password: "right-password" });

    const wrongPassword = await app.inject({
      method: "POST",
      url: `/api/gallery/${gallery.slug}/unlock`,
      payload: { password: "wrong-password" },
    });
    const missingSlug = await app.inject({
      method: "POST",
      url: "/api/gallery/definitely-not-a-real-slug/unlock",
      payload: { password: "anything-at-all" },
    });

    expect(wrongPassword.statusCode).toBe(missingSlug.statusCode);
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(missingSlug.json());

    const correct = await unlockGallery(app, gallery.slug, gallery.id, "right-password");
    expect(correct.res.statusCode).toBe(200);
    const photos = await app.inject({
      method: "GET",
      url: `/api/gallery/${gallery.slug}/photos`,
      cookies: { [`pixset_gallery_${gallery.id}`]: correct.cookie! },
    });
    expect(photos.statusCode).toBe(200);
  });
});
