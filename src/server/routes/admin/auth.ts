import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  hashPassword,
  revokeAdminSession,
  verifyPassword,
} from "../../services/auth.ts";
import { checkRateLimit, recordAttempt } from "../../services/rateLimiter.ts";
import { getClientIp } from "../../lib/http.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { consumeBackupCode, countUnusedBackupCodes, verifyTotpCode } from "../../services/totp.ts";
import { config } from "../../config.ts";

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string; code?: string } }>(
    "/api/admin/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", maxLength: 255 },
            password: { type: "string", maxLength: 512 },
            code: { type: "string", maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const ip = getClientIp(request);
      const rateLimit = await checkRateLimit({ scope: "admin_login", ip });
      if (!rateLimit.allowed) {
        reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
      }

      const { email, password, code } = request.body;
      const [admin] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.email, email.toLowerCase()))
        .limit(1);

      // Always run a verify (against a dummy hash if no such admin) so response
      // timing doesn't reveal whether the email exists.
      const passwordOk = admin
        ? await verifyPassword(admin.passwordHash, password)
        : await verifyPassword(DUMMY_HASH, password);

      if (!admin || !passwordOk) {
        await recordAttempt({ scope: "admin_login", ip, success: false });
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      // Second factor, when enabled. The password is correct at this point; a
      // missing code is a benign "need the code" prompt (not a failed attempt),
      // but a WRONG code counts against the rate limit like any bad login.
      if (admin.totpEnabledAt && admin.totpSecret) {
        if (!code) {
          return reply.code(401).send({ error: "totp_required" });
        }
        const totpOk = verifyTotpCode(admin.totpSecret, code);
        let backupConsumed = false;
        if (!totpOk) {
          const updated = consumeBackupCode(admin.totpBackupCodes, code);
          if (updated) {
            await db
              .update(schema.adminUsers)
              .set({ totpBackupCodes: updated })
              .where(eq(schema.adminUsers.id, admin.id));
            backupConsumed = true;
          }
        }
        if (!totpOk && !backupConsumed) {
          await recordAttempt({ scope: "admin_login", ip, success: false });
          return reply.code(401).send({ error: "invalid_code" });
        }
      }

      await recordAttempt({ scope: "admin_login", ip, success: true });

      const { rawToken, expiresAt } = await createAdminSession(admin.id, request.headers["user-agent"]);
      reply.setCookie(ADMIN_SESSION_COOKIE, rawToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: "strict",
        path: "/",
        expires: expiresAt,
      });

      return { ok: true, email: admin.email };
    },
  );

  app.post("/api/admin/logout", { preHandler: requireAdmin }, async (request, reply) => {
    const token = request.cookies[ADMIN_SESSION_COOKIE];
    if (token) await revokeAdminSession(token);
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/admin/me", { preHandler: requireAdmin }, async (request, reply) => {
    const [admin] = await db
      .select({
        id: schema.adminUsers.id,
        email: schema.adminUsers.email,
        totpEnabledAt: schema.adminUsers.totpEnabledAt,
        totpBackupCodes: schema.adminUsers.totpBackupCodes,
      })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, request.adminSession!.adminId))
      .limit(1);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    return {
      id: admin.id,
      email: admin.email,
      twoFactorEnabled: Boolean(admin.totpEnabledAt),
      backupCodesRemaining: countUnusedBackupCodes(admin.totpBackupCodes),
    };
  });
}

// A real Argon2id hash (computed once at boot, of an arbitrary value) used to
// force the same expensive verify computation whether or not the submitted
// email matches a real admin, so response timing doesn't leak which case it was.
const DUMMY_HASH = await hashPassword(`dummy-${Math.random()}`);
