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
}
