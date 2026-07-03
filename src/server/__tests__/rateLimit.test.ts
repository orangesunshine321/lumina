import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  cleanupDataDir,
  setupAdmin,
  db,
  schema,
  sqlite,
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

// TRUST_PROXY is off in tests, so getClientIp keys on the socket address —
// which inject's `remoteAddress` sets directly.
function loginFrom(remoteAddress: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: ADMIN_EMAIL, password },
    remoteAddress,
  });
}

describe("admin global rate-limit cap (cross-IP DoS protection)", () => {
  it("blocks a fresh IP once the global cap is hit, but never a known-good device", async () => {
    // A device that has logged in successfully becomes trusted.
    const good = await loginFrom("203.0.113.7", ADMIN_PASSWORD);
    expect(good.statusCode).toBe(200);

    // Simulate 100 failed admin logins spread across many IPs — an attacker
    // rotating source addresses to dodge the per-IP backoff. Seeded directly so
    // the test doesn't pay for 100 Argon2 verifications; the HTTP path is
    // exercised by the assertions below.
    await db.insert(schema.authAttempts).values(
      Array.from({ length: 100 }, (_, i) => ({
        scope: "admin_login" as const,
        galleryId: null,
        ipHash: `flood-${i}`,
        success: false,
      })),
    );

    // A brand-new attacker IP is blocked even WITH the correct password — the
    // cap is enforced before the credentials are ever checked.
    const fresh = await loginFrom("192.0.2.55", ADMIN_PASSWORD);
    expect(fresh.statusCode).toBe(429);
    expect(fresh.json().error).toBe("too_many_attempts");

    // The known-good device is exempt, so the sole admin can still get in while
    // the attack is ongoing — the cap can't be used to lock them out.
    const trusted = await loginFrom("203.0.113.7", ADMIN_PASSWORD);
    expect(trusted.statusCode).toBe(200);
  });
});
