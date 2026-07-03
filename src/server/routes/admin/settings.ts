import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { getSettings, updateSettings, SETTINGS_LIMITS as LIMITS } from "../../services/settings.ts";

interface SettingsBody {
  generateAvif?: boolean;
  uploadConcurrency?: number;
  maxUploadFileSizeBytes?: number;
  maxImagePixels?: number;
  publicBaseUrl?: string;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/admin/settings", { preHandler: requireAdmin }, async () => {
    return { settings: await getSettings(), limits: LIMITS };
  });

  app.patch<{ Body: SettingsBody }>(
    "/api/admin/settings",
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            generateAvif: { type: "boolean" },
            uploadConcurrency: { type: "integer" },
            maxUploadFileSizeBytes: { type: "integer" },
            maxImagePixels: { type: "integer" },
            publicBaseUrl: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request) => {
      const settings = await updateSettings(request.body);
      return { settings, limits: LIMITS };
    },
  );
}
