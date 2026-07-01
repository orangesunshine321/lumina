import { createHash } from "node:crypto";
import { and, eq, gte, lt, desc } from "drizzle-orm";
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

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${ip}:${config.sessionSecret}`).digest("hex");
}

const RETENTION_MS = 48 * 60 * 60 * 1000; // longer than any lookback window this module uses

/** Keeps the auth_attempts table from growing unboundedly over years of
 * operation — nothing here is ever queried past the retention window. */
export async function cleanupOldAuthAttempts(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await db.delete(schema.authAttempts).where(lt(schema.authAttempts.createdAt, cutoff));
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
    const globalResult = await checkAdminGlobalCap(now);
    if (!globalResult.allowed) return globalResult;
  }

  return { allowed: true };
}

async function checkAdminGlobalCap(now: number): Promise<RateLimitCheck> {
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
