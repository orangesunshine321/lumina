import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  cleanupDataDir,
  cookieValue,
  createApp,
  setupAdmin,
  sqlite,
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

function codeFor(secret: string): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.generate();
}

/** Runs the full enable flow and returns the secret + backup codes. */
async function enable2fa(): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await app.inject({
    method: "POST",
    url: "/api/admin/account/2fa/setup",
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
  const secret: string = setup.json().secret;
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  expect(setup.json().qrDataUrl).toContain("data:image/png;base64,");

  const enable = await app.inject({
    method: "POST",
    url: "/api/admin/account/2fa/enable",
    payload: { password: ADMIN_PASSWORD, code: codeFor(secret) },
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
  expect(enable.statusCode).toBe(200);
  const backupCodes: string[] = enable.json().backupCodes;
  expect(backupCodes).toHaveLength(10);
  // Always track the currently-active secret for later steps.
  (globalThis as Record<string, unknown>).__totpSecret = secret;
  return { secret, backupCodes };
}

describe("admin 2FA (TOTP)", () => {
  it("enrolls and reflects status in /me", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(before.json().twoFactorEnabled).toBe(false);

    const { secret } = await enable2fa();

    const after = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(after.json().twoFactorEnabled).toBe(true);
    expect(after.json().backupCodesRemaining).toBe(10);

    // enable requires a correct code
    const setup2 = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/setup",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(setup2.statusCode).toBe(409); // already enabled

    // stash secret for the login tests below
    (globalThis as Record<string, unknown>).__totpSecret = secret;
  });

  it("requires the second factor at login", async () => {
    const secret = (globalThis as Record<string, unknown>).__totpSecret as string;

    // Right password, no code → prompt for the code (not a hard failure).
    const noCode = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error).toBe("totp_required");
    expect(cookieValue(noCode, ADMIN_COOKIE)).toBeUndefined();

    // Right password, wrong code → rejected.
    const badCode = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: "000000" },
    });
    expect(badCode.statusCode).toBe(401);
    expect(badCode.json().error).toBe("invalid_code");

    // Right password + valid code → session issued.
    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: codeFor(secret) },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieValue(ok, ADMIN_COOKIE)).toBeTruthy();
  });

  it("accepts a single-use backup code, then rejects its reuse", async () => {
    // Re-enable fresh (previous test left it enabled; disable then re-enable to
    // get a known backup set through the return value).
    const secret = (globalThis as Record<string, unknown>).__totpSecret as string;
    const disable = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/disable",
      payload: { password: ADMIN_PASSWORD, code: codeFor(secret) },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(disable.statusCode).toBe(200);

    const { backupCodes } = await enable2fa();
    const oneCode = backupCodes[0]!;

    const first = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: oneCode },
    });
    expect(first.statusCode).toBe(200);
    expect(cookieValue(first, ADMIN_COOKIE)).toBeTruthy();

    // Same backup code again → rejected (single use).
    const reuse = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, code: oneCode },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error).toBe("invalid_code");

    // /me shows one fewer remaining.
    const me = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(me.json().backupCodesRemaining).toBe(9);
  });

  it("disable requires password AND a valid code", async () => {
    const secret2 = (
      await app.inject({
        method: "POST",
        url: "/api/admin/account/2fa/setup",
        cookies: { [ADMIN_COOKIE]: adminCookie },
      })
    ).json();
    // already enabled → setup 409s; disable with the ORIGINAL secret instead.
    expect(secret2.error).toBe("already_enabled");
    const secret = (globalThis as Record<string, unknown>).__totpSecret as string;

    const wrongPw = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/disable",
      payload: { password: "nope", code: codeFor(secret) },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(wrongPw.statusCode).toBe(403);

    const good = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/disable",
      payload: { password: ADMIN_PASSWORD, code: codeFor(secret) },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(good.statusCode).toBe(200);

    // Login no longer needs a code.
    const plain = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(plain.statusCode).toBe(200);
  });
});
