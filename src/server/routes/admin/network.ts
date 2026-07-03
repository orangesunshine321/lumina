import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { getPublicBaseUrl, normalizeBaseUrl, updateSettings } from "../../services/settings.ts";
import {
  buildProxyDiagnostics,
  runSelfTest,
  cfVerifyToken,
  cfProvisionTunnel,
  CloudflareError,
} from "../../services/network.ts";

/**
 * Admin-only endpoints backing the "Public access" wizard. The app can only
 * guide/verify/drive-the-CF-API — it can't apply Docker changes (see
 * services/network.ts). Cloudflare API tokens are used transiently and never
 * stored, so they can't leak into DB backups.
 */
export async function networkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  // What proxy/TLS posture is this instance actually seeing right now?
  app.get("/api/admin/network/status", async (request) => {
    const publicBaseUrl = await getPublicBaseUrl();
    return { diagnostics: buildProxyDiagnostics(request, publicBaseUrl) };
  });

  // Fetch our own public URL and confirm it loops back to this instance.
  app.post<{ Body: { url?: string } }>("/api/admin/network/self-test", async (request, reply) => {
    const configured = await getPublicBaseUrl();
    const target = normalizeBaseUrl(request.body?.url ?? configured);
    if (!target) {
      return reply.code(400).send({ error: "no_public_url" });
    }
    return { result: await runSelfTest(target) };
  });

  // Verify a Cloudflare API token and list the domains it can manage.
  app.post<{ Body: { apiToken?: string } }>("/api/admin/network/cloudflare/verify", async (request, reply) => {
    const token = request.body?.apiToken?.trim();
    if (!token) {
      return reply.code(400).send({ error: "missing_token" });
    }
    try {
      return await cfVerifyToken(token);
    } catch (err) {
      const message = err instanceof CloudflareError ? err.message : "Cloudflare request failed.";
      return reply.code(400).send({ error: "cloudflare_error", message });
    }
  });

  // Create the tunnel + ingress + DNS for a hostname; hand back the connector
  // token and the exact command for the operator to run on their host.
  app.post<{ Body: { apiToken?: string; hostname?: string; tunnelName?: string } }>(
    "/api/admin/network/cloudflare/provision",
    async (request, reply) => {
      const token = request.body?.apiToken?.trim();
      const hostname = request.body?.hostname?.trim();
      const tunnelName = request.body?.tunnelName?.trim() || "lumina";
      if (!token) return reply.code(400).send({ error: "missing_token" });
      if (!hostname) return reply.code(400).send({ error: "missing_hostname" });
      try {
        const provisioned = await cfProvisionTunnel(token, hostname, tunnelName);
        // Provisioning succeeded → adopt this hostname as the app's public URL so
        // share links use it immediately.
        const publicBaseUrl = normalizeBaseUrl(`https://${provisioned.hostname}`);
        if (publicBaseUrl) await updateSettings({ publicBaseUrl });
        return {
          result: {
            ...provisioned,
            publicBaseUrl,
            envLine: `CLOUDFLARE_TUNNEL_TOKEN=${provisioned.tunnelToken}`,
            command: "docker compose --profile tunnel up -d",
          },
        };
      } catch (err) {
        const message = err instanceof CloudflareError ? err.message : "Cloudflare provisioning failed.";
        return reply.code(400).send({ error: "cloudflare_error", message });
      }
    },
  );
}
