import { randomBytes, createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { SignJWT, jwtVerify } from "jose";
import { eq, and, gt, lt } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { config } from "../config.ts";

// @node-rs/argon2's `Algorithm` is an ambient `const enum`, which TS can't
// safely reference under `isolatedModules` (required for single-file
// transpilation by tsx/esbuild) — so we use its known raw value directly.
// Algorithm.Argon2id === 2 (see node_modules/@node-rs/argon2/index.d.ts).
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  // Current (2026) OWASP guidance floor for Argon2id.
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2Verify(hash, plain).catch(() => false);
}

// ---------------------------------------------------------------------------
// Admin sessions — DB-backed (not stateless). Admin login volume is trivial,
// so a real per-device revocable session is essentially free and buys genuine
// "sign out this device" / "sign out everywhere" semantics.
// ---------------------------------------------------------------------------

export const ADMIN_SESSION_COOKIE = "pixset_admin_session";
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function createAdminSession(adminId: string, userAgent: string | undefined) {
  const rawToken = randomBytes(32).toString("hex");
  const id = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  await db.insert(schema.adminSessions).values({
    id,
    adminId,
    userAgent: userAgent?.slice(0, 255),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

/** Only rewrite lastSeenAt/expiresAt when the last touch is at least this old —
 * this function runs for every photo-byte request the admin grid makes, and an
 * unconditional UPDATE would mean hundreds of pointless writes per page view. */
const SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

export async function verifyAdminSession(rawToken: string | undefined) {
  if (!rawToken) return null;
  const id = sha256Hex(rawToken);
  const now = new Date();
  // Joined against admin_users so a session can never outlive its account —
  // the documented password-reset recovery deletes the admin row from the
  // sqlite3 CLI, where foreign_keys is OFF and the cascade doesn't fire.
  const [row] = await db
    .select({ session: schema.adminSessions })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.adminId))
    .where(and(eq(schema.adminSessions.id, id), gt(schema.adminSessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const session = row.session;

  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await db
      .update(schema.adminSessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS) })
      .where(eq(schema.adminSessions.id, id));
  }

  return session;
}

export async function revokeAdminSession(rawToken: string) {
  const id = sha256Hex(rawToken);
  await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, id));
}

export async function revokeAllAdminSessions(adminId: string) {
  await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminId, adminId));
}

/** Keeps the admin_sessions table from accumulating expired rows forever. */
export async function cleanupExpiredAdminSessions(): Promise<void> {
  await db.delete(schema.adminSessions).where(lt(schema.adminSessions.expiresAt, new Date()));
}

// ---------------------------------------------------------------------------
// Gallery access — stateless signed cookies. A browsing session can fetch
// hundreds of photo byte-requests, so a per-request DB lookup would be wasted
// work; a signed JWT carrying passwordVersion lets a password change/removal
// instantly invalidate every previously issued cookie with zero server state.
// ---------------------------------------------------------------------------

const GALLERY_ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const CLIENT_TOKEN_COOKIE = "pixset_client";
const CLIENT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function secretKey() {
  return new TextEncoder().encode(config.sessionSecret);
}

export function galleryAccessCookieName(galleryId: string) {
  return `pixset_gallery_${galleryId}`;
}

export async function issueGalleryAccessToken(galleryId: string, passwordVersion: number) {
  return new SignJWT({ galleryId, passwordVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${GALLERY_ACCESS_TTL_SECONDS}s`)
    .sign(secretKey());
}

export interface GalleryAccessPayload {
  galleryId: string;
  passwordVersion: number;
}

export async function verifyGalleryAccessToken(
  token: string | undefined,
): Promise<GalleryAccessPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.galleryId !== "string" || typeof payload.passwordVersion !== "number") {
      return null;
    }
    return { galleryId: payload.galleryId, passwordVersion: payload.passwordVersion };
  } catch {
    return null;
  }
}

export { CLIENT_TOKEN_COOKIE, CLIENT_TOKEN_TTL_MS, GALLERY_ACCESS_TTL_SECONDS };
