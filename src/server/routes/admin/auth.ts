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
import { consumeBackupCode, countUnusedBackupCodes, verifyTotpCodeStep } from "../../services/totp.ts";
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
        // Verify the TOTP code AND atomically claim its timestep: the
        // conditional UPDATE only succeeds if this step is newer than the last
        // one consumed, so a captured code can't be replayed within its ~90s
        // window (even by two concurrent logins) to mint a second session.
        const step = verifyTotpCodeStep(admin.totpSecret, code);
        let totpOk = false;
        if (step !== null) {
          const res = db.$client
            .prepare(
              "UPDATE admin_users SET totp_last_used_step = ? WHERE id = ? AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)",
            )
            .run(step, admin.id, step);
          totpOk = res.changes === 1;
        }
        let backupConsumed = false;
        if (!totpOk) {
          // Consume the backup code atomically: re-read the codes column and
          // write it back inside one synchronous better-sqlite3 transaction, so
          // two concurrent logins can't both spend the same single-use code (or
          // clobber each other's write and resurrect a spent one). `admin`'s
          // copy is a stale snapshot from before the argon2 await — never mutate
          // that; re-read the live value here.
          backupConsumed = db.$client.transaction(() => {
            const row = db.$client
              .prepare("SELECT totp_backup_codes AS codes FROM admin_users WHERE id = ?")
              .get(admin.id) as { codes: string | null } | undefined;
            const updated = consumeBackupCode(row?.codes ?? null, code);
            if (!updated) return false;
            db.$client
              .prepare("UPDATE admin_users SET totp_backup_codes = ? WHERE id = ?")
              .run(updated, admin.id);
            return true;
          })();
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
        notifyWebhookUrl: schema.adminUsers.notifyWebhookUrl,
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
      webhookUrl: admin.notifyWebhookUrl,
    };
  });
}

// A real Argon2id hash (computed once at boot, of an arbitrary value) used to
// force the same expensive verify computation whether or not the submitted
// email matches a real admin, so response timing doesn't leak which case it was.
const DUMMY_HASH = await hashPassword(`dummy-${Math.random()}`);
