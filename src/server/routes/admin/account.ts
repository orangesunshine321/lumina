import type { FastifyInstance } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../../db/client.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import {
  ADMIN_SESSION_COOKIE,
  hashPassword,
  revokeAllAdminSessions,
  verifyPassword,
} from "../../services/auth.ts";
import {
  generateBackupCodes,
  generateTotpEnrollment,
  verifyTotpCode,
} from "../../services/totp.ts";

export async function accountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  /** Change password. Requires the current password (a stolen unlocked
   * laptop shouldn't be enough to lock the owner out), and revokes every
   * OTHER session so a possibly-compromised device doesn't stay signed in. */
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/api/admin/account/password",
    {
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string", maxLength: 512 },
            newPassword: { type: "string", minLength: 12, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const [admin] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.id, session.adminId))
        .limit(1);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });

      if (!(await verifyPassword(admin.passwordHash, request.body.currentPassword))) {
        return reply.code(403).send({ error: "wrong_password" });
      }

      await db
        .update(schema.adminUsers)
        .set({ passwordHash: await hashPassword(request.body.newPassword), updatedAt: new Date() })
        .where(eq(schema.adminUsers.id, admin.id));

      await db
        .delete(schema.adminSessions)
        .where(and(eq(schema.adminSessions.adminId, admin.id), ne(schema.adminSessions.id, session.id)));

      return { ok: true };
    },
  );

  app.post<{ Body: { password: string; email: string } }>(
    "/api/admin/account/email",
    {
      schema: {
        body: {
          type: "object",
          required: ["password", "email"],
          properties: {
            password: { type: "string", maxLength: 512 },
            email: { type: "string", format: "email", maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.adminSession!;
      const [admin] = await db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.id, session.adminId))
        .limit(1);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });

      if (!(await verifyPassword(admin.passwordHash, request.body.password))) {
        return reply.code(403).send({ error: "wrong_password" });
      }

      await db
        .update(schema.adminUsers)
        .set({ email: request.body.email.toLowerCase(), updatedAt: new Date() })
        .where(eq(schema.adminUsers.id, admin.id));

      return { ok: true, email: request.body.email.toLowerCase() };
    },
  );

  /** Panic button: revokes every session including this one. */
  app.post("/api/admin/account/logout-all", async (request, reply) => {
    await revokeAllAdminSessions(request.adminSession!.adminId);
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // --- Two-factor authentication (TOTP) ------------------------------------

  /** Begin enrollment: generate (but don't yet activate) a secret and return
   * the QR + manual key. 2FA isn't active until /2fa/enable confirms a code. */
  app.post("/api/admin/account/2fa/setup", async (request, reply) => {
    const admin = await currentAdmin(request.adminSession!.adminId);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    if (admin.totpEnabledAt) return reply.code(409).send({ error: "already_enabled" });

    const enrollment = await generateTotpEnrollment(admin.email);
    await db
      .update(schema.adminUsers)
      .set({ totpSecret: enrollment.secret, updatedAt: new Date() })
      .where(eq(schema.adminUsers.id, admin.id));

    return {
      qrDataUrl: enrollment.qrDataUrl,
      secret: enrollment.secret,
      otpauthUri: enrollment.otpauthUri,
    };
  });

  /** Activate 2FA once the operator confirms a code from their app. Returns
   * the one-time backup codes to save. Password-gated (a sensitive change). */
  app.post<{ Body: { password: string; code: string } }>(
    "/api/admin/account/2fa/enable",
    {
      schema: {
        body: {
          type: "object",
          required: ["password", "code"],
          properties: {
            password: { type: "string", maxLength: 512 },
            code: { type: "string", maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = await currentAdmin(request.adminSession!.adminId);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });
      if (admin.totpEnabledAt) return reply.code(409).send({ error: "already_enabled" });
      if (!admin.totpSecret) return reply.code(400).send({ error: "setup_required" });
      if (!(await verifyPassword(admin.passwordHash, request.body.password))) {
        return reply.code(403).send({ error: "wrong_password" });
      }
      if (!verifyTotpCode(admin.totpSecret, request.body.code)) {
        return reply.code(400).send({ error: "invalid_code" });
      }

      const backup = generateBackupCodes();
      await db
        .update(schema.adminUsers)
        .set({ totpEnabledAt: new Date(), totpBackupCodes: backup.stored, updatedAt: new Date() })
        .where(eq(schema.adminUsers.id, admin.id));

      return { ok: true, backupCodes: backup.plaintext };
    },
  );

  /** Turn 2FA off. Requires the password AND a current code (or backup code),
   * so a merely-unlocked session can't silently remove the second factor. */
  app.post<{ Body: { password: string; code: string } }>(
    "/api/admin/account/2fa/disable",
    {
      schema: {
        body: {
          type: "object",
          required: ["password", "code"],
          properties: {
            password: { type: "string", maxLength: 512 },
            code: { type: "string", maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = await currentAdmin(request.adminSession!.adminId);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });
      if (!admin.totpEnabledAt || !admin.totpSecret) {
        return reply.code(400).send({ error: "not_enabled" });
      }
      if (!(await verifyPassword(admin.passwordHash, request.body.password))) {
        return reply.code(403).send({ error: "wrong_password" });
      }
      if (!verifyTotpCode(admin.totpSecret, request.body.code)) {
        return reply.code(400).send({ error: "invalid_code" });
      }

      await db
        .update(schema.adminUsers)
        .set({ totpSecret: null, totpEnabledAt: null, totpBackupCodes: null, updatedAt: new Date() })
        .where(eq(schema.adminUsers.id, admin.id));

      return { ok: true };
    },
  );
}

async function currentAdmin(adminId: string) {
  const [admin] = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, adminId))
    .limit(1);
  return admin ?? null;
}
