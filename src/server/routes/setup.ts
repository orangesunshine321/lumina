import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { generateId } from "../lib/ids.ts";
import { ADMIN_SESSION_COOKIE, createAdminSession, hashPassword } from "../services/auth.ts";
import { config } from "../config.ts";

/**
 * First-run admin creation. No credentials ever live in `.env`/compose — this
 * route is the ONLY way an admin account is created, and it permanently
 * disables itself the instant one exists (checked fresh on every request, not
 * cached, so it can never be re-opened by a stale process).
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => {
    const needsSetup = !(await adminExists());
    return { needsSetup };
  });

  app.post<{ Body: { email: string; password: string } }>(
    "/api/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 255 },
            password: { type: "string", minLength: 12, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      if (await adminExists()) {
        return reply.code(403).send({ error: "setup_already_completed" });
      }

      const { email, password } = request.body;
      const passwordHash = await hashPassword(password);
      const id = generateId();

      // The exists-check above races: hashing takes ~100ms, and a second
      // concurrent setup POST can pass the check during that window. The
      // INSERT itself is guarded so only one request can ever win.
      const now = Date.now();
      const result = db.$client
        .prepare(
          `INSERT INTO admin_users (id, email, password_hash, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM admin_users)`,
        )
        .run(id, email.toLowerCase(), passwordHash, now, now);
      if (result.changes === 0) {
        return reply.code(403).send({ error: "setup_already_completed" });
      }

      const { rawToken, expiresAt } = await createAdminSession(id, request.headers["user-agent"]);
      reply.setCookie(ADMIN_SESSION_COOKIE, rawToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: "strict",
        path: "/",
        expires: expiresAt,
      });

      return { ok: true };
    },
  );
}

async function adminExists(): Promise<boolean> {
  const [row] = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1);
  return Boolean(row);
}
