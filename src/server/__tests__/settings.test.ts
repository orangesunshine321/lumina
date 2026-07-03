import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_COOKIE, cleanupDataDir, createApp, setupAdmin, sqlite, type App } from "./helpers.ts";

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

function get() {
  return app.inject({
    method: "GET",
    url: "/api/admin/settings",
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
}

function patch(payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: "/api/admin/settings",
    payload,
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
}

describe("app settings", () => {
  it("requires an admin session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/settings" });
    expect(res.statusCode).toBe(401);
  });

  it("returns defaults, then persists updates", async () => {
    const before = await get();
    expect(before.statusCode).toBe(200);
    expect(before.json().settings.uploadConcurrency).toBe(4); // config default
    expect(before.json().settings.generateAvif).toBe(true);

    const res = await patch({ uploadConcurrency: 8, generateAvif: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.uploadConcurrency).toBe(8);
    expect(res.json().settings.generateAvif).toBe(false);

    // Reflected on a fresh read (cache invalidated on write).
    const after = await get();
    expect(after.json().settings.uploadConcurrency).toBe(8);
    expect(after.json().settings.generateAvif).toBe(false);
  });

  it("clamps out-of-range values to the allowed limits", async () => {
    const high = await patch({ uploadConcurrency: 9999 });
    expect(high.json().settings.uploadConcurrency).toBe(high.json().limits.uploadConcurrency.max);

    const low = await patch({ uploadConcurrency: 0 });
    expect(low.json().settings.uploadConcurrency).toBe(low.json().limits.uploadConcurrency.min);
  });

  it("ignores unknown settings keys while applying known ones", async () => {
    const res = await patch({ notARealSetting: 1, uploadConcurrency: 6 });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.uploadConcurrency).toBe(6);
    expect(res.json().settings).not.toHaveProperty("notARealSetting");
  });

  it("normalizes and persists a custom public base URL", async () => {
    // Defaults to empty (no custom domain).
    const before = await get();
    expect(before.json().settings.publicBaseUrl).toBe("");

    // A bare host is upgraded to https and trailing path/slash is dropped.
    const bare = await patch({ publicBaseUrl: "gallery.example.com" });
    expect(bare.json().settings.publicBaseUrl).toBe("https://gallery.example.com");

    const withPath = await patch({ publicBaseUrl: "https://foo.example.com/g/x/" });
    expect(withPath.json().settings.publicBaseUrl).toBe("https://foo.example.com");

    // Garbage (and non-http schemes) normalize back to empty.
    const junk = await patch({ publicBaseUrl: "not a url" });
    expect(junk.json().settings.publicBaseUrl).toBe("");
  });
});
