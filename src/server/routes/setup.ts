import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { generateId } from "../lib/ids.ts";
import { ADMIN_SESSION_COOKIE, createAdminSession, hashPassword } from "../services/auth.ts";
import { clearSetupToken, verifySetupToken } from "../services/setupToken.ts";
import { checkRateLimit, recordAttempt } from "../services/rateLimiter.ts";
import { getSettings, updateSettings, SETTINGS_LIMITS } from "../services/settings.ts";
import { getClientIp } from "../lib/http.ts";
import { config } from "../config.ts";

interface SetupSettings {
  generateAvif?: boolean;
  uploadConcurrency?: number;
  maxUploadFileSizeBytes?: number;
  maxImagePixels?: number;
}

/**
 * First-run admin creation. No credentials ever live in `.env`/compose — this
 * route is the ONLY way an admin account is created, and it permanently
 * disables itself the instant one exists (checked fresh on every request, not
 * cached, so it can never be re-opened by a stale process).
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => {
    const needsSetup = !(await adminExists());
    // Include current defaults + limits so the setup screen can offer optional
    // first-run tuning without a second request (these aren't sensitive).
    return { needsSetup, settings: await getSettings(), limits: SETTINGS_LIMITS };
  });

  app.post<{ Body: { email: string; password: string; setupToken: string; settings?: SetupSettings } }>(
    "/api/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password", "setupToken"],
          properties: {
            email: { type: "string", format: "email", maxLength: 255 },
            password: { type: "string", minLength: 12, maxLength: 512 },
            setupToken: { type: "string", maxLength: 128 },
            // Optional first-run tuning — saved to the same store the settings
            // panel edits, so the operator can configure processing up front.
            settings: {
              type: "object",
              additionalProperties: false,
              properties: {
                generateAvif: { type: "boolean" },
                uploadConcurrency: { type: "integer" },
                maxUploadFileSizeBytes: { type: "integer" },
                maxImagePixels: { type: "integer" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (await adminExists()) {
        return reply.code(403).send({ error: "setup_already_completed" });
      }

      // Rate-limit the setup code the same way as a login, so it can't be
      // brute-forced even in the pre-account window on a public URL.
      const ip = getClientIp(request);
      const rateLimit = await checkRateLimit({ scope: "admin_login", ip });
      if (!rateLimit.allowed) {
        reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
      }

      if (!verifySetupToken(request.body.setupToken)) {
        await recordAttempt({ scope: "admin_login", ip, success: false });
        return reply.code(403).send({ error: "invalid_setup_token" });
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

      clearSetupToken();
      await recordAttempt({ scope: "admin_login", ip, success: true });

      // Persist any first-run tuning the operator chose (values are clamped).
      if (request.body.settings) {
        await updateSettings(request.body.settings);
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
