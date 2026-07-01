import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  cleanupDataDir,
  cookieValue,
  setupAdmin,
  sqlite,
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type App,
} from "./helpers.ts";

let app: App;

beforeAll(async () => {
  app = await createApp();
  await setupAdmin(app);
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

function login(password: string, email = ADMIN_EMAIL) {
  return app.inject({ method: "POST", url: "/api/admin/login", payload: { email, password } });
}

describe("admin auth", () => {
  it("rejects a wrong password", async () => {
    const res = await login("definitely-wrong");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("logs in, authenticates /me, and logout revokes the session", async () => {
    const res = await login(ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = cookieValue(res, ADMIN_COOKIE)!;
    expect(cookie).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(ADMIN_EMAIL);

    const logout = await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(logout.statusCode).toBe(200);

    const meAfter = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("sessions die with the account even when the CLI recovery skips cascades (A9)", async () => {
    const res = await login(ADMIN_PASSWORD);
    const cookie = cookieValue(res, ADMIN_COOKIE)!;
    const meBefore = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(meBefore.statusCode).toBe(200);

    // Reproduce the documented sqlite3-CLI recovery: foreign_keys is OFF
    // there, so the delete does NOT cascade to admin_sessions.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare("DELETE FROM admin_users").run();
    sqlite.pragma("foreign_keys = ON");

    const orphans = sqlite.prepare("SELECT COUNT(*) AS c FROM admin_sessions").get() as { c: number };
    expect(orphans.c).toBeGreaterThan(0); // the orphaned rows really are still there…

    const meAfter = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: cookie },
    });
    expect(meAfter.statusCode).toBe(401); // …but they no longer authenticate.
  });

  it("locks out after 5 consecutive failures (rate limit)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login("wrong-password");
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login("wrong-password");
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.error).toBe("too_many_attempts");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});
