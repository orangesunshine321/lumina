import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",

  dataDir,
  databasePath: process.env.DATABASE_PATH ?? resolve(dataDir, "db/app.sqlite"),
  backupsDir: process.env.BACKUPS_DIR ?? resolve(dataDir, "db/backups"),
  photosDir: process.env.PHOTOS_PATH ?? resolve(dataDir, "photos"),
  originalsDir: resolve(process.env.PHOTOS_PATH ?? resolve(dataDir, "photos"), "originals"),
  derivedDir: resolve(process.env.PHOTOS_PATH ?? resolve(dataDir, "photos"), "derived"),
  uploadTmpDir: resolve(process.env.PHOTOS_PATH ?? resolve(dataDir, "photos"), "tmp"),

  // Generate with: openssl rand -hex 32. Required in production; a dev-only
  // fallback is used so `npm run dev` works out of the box before .env exists.
  sessionSecret: process.env.SESSION_SECRET ?? devFallbackSecret(),

  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  trustProxy: process.env.TRUST_PROXY === "true",
  uploadConcurrency: Number(process.env.UPLOAD_CONCURRENCY ?? 4),
  maxUploadFileSizeBytes: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES ?? 50 * 1024 * 1024),
};

function devFallbackSecret(): string {
  if (process.env.NODE_ENV === "production") {
    return required("SESSION_SECRET");
  }
  return "dev-only-insecure-secret-do-not-use-in-production-00000000";
}
