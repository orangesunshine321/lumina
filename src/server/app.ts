import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyCompress from "@fastify/compress";
import "./types.ts";
import { config } from "./config.ts";
import { setupRoutes } from "./routes/setup.ts";
import { adminAuthRoutes } from "./routes/admin/auth.ts";
import { photoRoutes } from "./routes/photos.ts";
import { galleryAdminRoutes } from "./routes/admin/galleries.ts";
import { uploadRoutes } from "./routes/admin/uploads.ts";
import { exportRoutes } from "./routes/admin/export.ts";
import { publicGalleryRoutes } from "./routes/gallery/public.ts";
import { systemRoutes } from "./routes/admin/system.ts";
import { photoManageRoutes } from "./routes/admin/photosManage.ts";

const WEB_DIST = resolve(process.cwd(), "dist/web");

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.isProduction ? "info" : "debug",
      transport: config.isProduction ? undefined : { target: "pino-pretty" },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024, // 1MB default for JSON bodies; uploads use multipart's own limit
    // Without this, an open SSE connection (admin upload-progress stream)
    // keeps app.close() waiting forever and every shutdown ends in SIGKILL.
    forceCloseConnections: true,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadFileSizeBytes, files: 1 },
  });
  // Compresses text responses (the SPA bundle, JSON). Images/zips are already
  // compressed formats and are skipped by content-type.
  await app.register(fastifyCompress);

  // Minimal, zero-dependency security headers — no need for a full helmet
  // plugin for a handful of static values.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(setupRoutes);
  await app.register(adminAuthRoutes);
  await app.register(photoRoutes);
  await app.register(galleryAdminRoutes);
  await app.register(uploadRoutes);
  await app.register(exportRoutes);
  await app.register(publicGalleryRoutes);
  await app.register(systemRoutes);
  await app.register(photoManageRoutes);

  if (config.isProduction && existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Vite assets are content-hashed → cache forever. index.html must be
        // revalidated every load, or a stale copy keeps requesting JS/CSS
        // hashes that no longer exist after a rebuild (blank app for an hour).
        if (filePath.includes(`${sep}assets${sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    if (error.validation) {
      return reply.code(400).send({ error: "invalid_request", details: error.message });
    }
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : (error.message ?? "error"),
    });
  });

  return app;
}
