import { createHash } from "node:crypto";
import { and, eq, gte, lt, desc, ne, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { config } from "../config.ts";

export type RateLimitScope = "admin_login" | "gallery_unlock";

const PER_IP_THRESHOLD = 5; // failures before backoff kicks in
const PER_IP_MAX_BACKOFF_MINUTES = 60;
const PER_IP_LOOKBACK_ROWS = 50;

const PER_GALLERY_THRESHOLD = 30; // coarse cap across all IPs, blunts distributed guessing
const PER_GALLERY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cross-IP cap for admin login. The per-IP backoff keys on X-Forwarded-For,
// which is attacker-controlled if the app is ever exposed without a proxy —
// this cap can't be dodged by rotating the header. Generous enough that a
// single fumbling human never hits it.
const ADMIN_GLOBAL_THRESHOLD = 100;
const ADMIN_GLOBAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// How long a device that completed a successful admin login stays exempt from
// the global cap. Without this exemption the cap doubles as an availability
// lever: an attacker flooding failed logins from OTHER IPs could lock the sole
// admin out. An attacker can't fake the exemption — a success row requires
// valid credentials — and it's keyed on the salted IP hash. Successful admin
// logins are retained this long (see cleanupOldAuthAttempts) so the window is
// real; a daily-active admin never loses trust.
const ADMIN_TRUSTED_IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${ip}:${config.sessionSecret}`).digest("hex");
}

const RETENTION_MS = 48 * 60 * 60 * 1000; // longer than any lookback window this module uses

/** Keeps the auth_attempts table from growing unboundedly over years of
 * operation. Everything is purged at the short retention EXCEPT successful
 * admin logins, which are kept for the trusted-IP window so a known-good device
 * stays exempt from the global admin cap (see checkAdminGlobalCap). */
export async function cleanupOldAuthAttempts(): Promise<void> {
  const now = Date.now();
  const generalCutoff = new Date(now - RETENTION_MS);
  const trustedCutoff = new Date(now - ADMIN_TRUSTED_IP_WINDOW_MS);

  await db
    .delete(schema.authAttempts)
    .where(
      and(
        lt(schema.authAttempts.createdAt, generalCutoff),
        // Keep successful admin logins longer (De Morgan of NOT(admin_login AND
        // success)): they're what makes a device "known-good" for the cap.
        or(
          ne(schema.authAttempts.scope, "admin_login"),
          eq(schema.authAttempts.success, false),
        ),
      ),
    );

  // Expire the retained successful-login rows once they age past the window.
  await db
    .delete(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, "admin_login"),
        eq(schema.authAttempts.success, true),
        lt(schema.authAttempts.createdAt, trustedCutoff),
      ),
    );
}

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Durable, restart-proof brute-force protection backed by the auth_attempts
 * table — no Redis, no in-memory counters that reset on deploy.
 */
export async function checkRateLimit(params: {
  scope: RateLimitScope;
  galleryId?: string;
  ip: string;
}): Promise<RateLimitCheck> {
  const ipHash = hashIp(params.ip);
  const now = Date.now();

  const perIpResult = await checkPerIpBackoff(params.scope, ipHash, now);
  if (!perIpResult.allowed) return perIpResult;

  if (params.scope === "gallery_unlock" && params.galleryId) {
    const perGalleryResult = await checkPerGalleryCap(params.galleryId, now);
    if (!perGalleryResult.allowed) return perGalleryResult;
  }

  if (params.scope === "admin_login") {
    const globalResult = await checkAdminGlobalCap(now, ipHash);
    if (!globalResult.allowed) return globalResult;
  }

  return { allowed: true };
}

async function checkAdminGlobalCap(now: number, ipHash: string): Promise<RateLimitCheck> {
  // Known-good device exemption: an IP that completed a successful admin login
  // within the trust window is never blocked by the global cap, so a flood of
  // failed logins from other IPs can't lock the legitimate admin out. This
  // can't be forged — writing a success row requires valid credentials — and
  // it only relaxes the cross-IP cap, never the per-IP backoff above.
  const trustedSince = new Date(now - ADMIN_TRUSTED_IP_WINDOW_MS);
  const [trusted] = await db
    .select({ createdAt: schema.authAttempts.createdAt })
    .from(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, "admin_login"),
        eq(schema.authAttempts.ipHash, ipHash),
        eq(schema.authAttempts.success, true),
        gte(schema.authAttempts.createdAt, trustedSince),
      ),
    )
    .limit(1);
  if (trusted) return { allowed: true };

  const windowStart = new Date(now - ADMIN_GLOBAL_WINDOW_MS);
  const recentFailures = await db
    .select({ createdAt: schema.authAttempts.createdAt })
    .from(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, "admin_login"),
        eq(schema.authAttempts.success, false),
        gte(schema.authAttempts.createdAt, windowStart),
      ),
    )
    .orderBy(schema.authAttempts.createdAt);

  if (recentFailures.length < ADMIN_GLOBAL_THRESHOLD) {
    return { allowed: true };
  }

  const oldest = recentFailures[0]!.createdAt.getTime();
  const unlocksAt = oldest + ADMIN_GLOBAL_WINDOW_MS;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - now) / 1000)) };
}

async function checkPerIpBackoff(
  scope: RateLimitScope,
  ipHash: string,
  now: number,
): Promise<RateLimitCheck> {
  const recent = await db
    .select({ success: schema.authAttempts.success, createdAt: schema.authAttempts.createdAt })
    .from(schema.authAttempts)
    .where(and(eq(schema.authAttempts.scope, scope), eq(schema.authAttempts.ipHash, ipHash)))
    .orderBy(desc(schema.authAttempts.createdAt))
    .limit(PER_IP_LOOKBACK_ROWS);

  let consecutiveFailures = 0;
  let lastFailureAt: number | null = null;
  for (const row of recent) {
    if (row.success) break;
    consecutiveFailures += 1;
    if (lastFailureAt === null) lastFailureAt = row.createdAt.getTime();
  }

  if (consecutiveFailures < PER_IP_THRESHOLD || lastFailureAt === null) {
    return { allowed: true };
  }

  const backoffMinutes = Math.min(
    2 ** (consecutiveFailures - PER_IP_THRESHOLD),
    PER_IP_MAX_BACKOFF_MINUTES,
  );
  const lockedUntil = lastFailureAt + backoffMinutes * 60_000;
  if (now < lockedUntil) {
    return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

async function checkPerGalleryCap(galleryId: string, now: number): Promise<RateLimitCheck> {
  const windowStart = new Date(now - PER_GALLERY_WINDOW_MS);
  const recentFailures = await db
    .select({ createdAt: schema.authAttempts.createdAt })
    .from(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, "gallery_unlock"),
        eq(schema.authAttempts.galleryId, galleryId),
        eq(schema.authAttempts.success, false),
        gte(schema.authAttempts.createdAt, windowStart),
      ),
    )
    .orderBy(schema.authAttempts.createdAt);

  if (recentFailures.length < PER_GALLERY_THRESHOLD) {
    return { allowed: true };
  }

  const oldest = recentFailures[0]!.createdAt.getTime();
  const unlocksAt = oldest + PER_GALLERY_WINDOW_MS;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - now) / 1000)) };
}

export async function recordAttempt(params: {
  scope: RateLimitScope;
  galleryId?: string;
  ip: string;
  success: boolean;
}) {
  await db.insert(schema.authAttempts).values({
    scope: params.scope,
    galleryId: params.galleryId ?? null,
    ipHash: hashIp(params.ip),
    success: params.success,
  });
}
