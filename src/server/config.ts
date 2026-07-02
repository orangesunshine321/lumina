import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const photosDir = process.env.PHOTOS_PATH ?? resolve(dataDir, "photos");

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",

  dataDir,
  databasePath: process.env.DATABASE_PATH ?? resolve(dataDir, "db/app.sqlite"),
  backupsDir: process.env.BACKUPS_DIR ?? resolve(dataDir, "db/backups"),
  photosDir,
  originalsDir: resolve(photosDir, "originals"),
  derivedDir: resolve(photosDir, "derived"),
  uploadTmpDir: resolve(photosDir, "tmp"),

  sessionSecret: resolveSessionSecret(),

  trustProxy: process.env.TRUST_PROXY === "true",
  uploadConcurrency: Number(process.env.UPLOAD_CONCURRENCY ?? 4),
  maxUploadFileSizeBytes: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES ?? 50 * 1024 * 1024),
  // Decompression-bomb ceiling. 100 MP comfortably covers real cameras (a
  // 100MP medium-format frame is ~11600×8700), while rejecting crafted images
  // that would balloon memory on decode. Arms both the upload probe and
  // sharp's own limitInputPixels in the image pipeline.
  maxImagePixels: Number(process.env.MAX_IMAGE_PIXELS ?? 100_000_000),
  // Also emit AVIF derivatives (smaller than WebP → faster galleries on mobile
  // data), served to supporting browsers via Accept negotiation. Costs extra
  // background encode time; set GENERATE_AVIF=false on slow hardware to skip.
  generateAvif: process.env.GENERATE_AVIF !== "false",
};

/** The signing key for gallery-access cookies. Zero-config by default: if the
 * operator doesn't provide SESSION_SECRET, one is generated on first boot and
 * persisted next to the database, so it survives restarts (a changing secret
 * would log every client out of every gallery). An explicit env var always
 * wins — that's the escape hatch for multi-instance or key-rotation setups. */
function resolveSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  const secretPath = resolve(dataDir, "db/session-secret");
  if (existsSync(secretPath)) {
    const persisted = readFileSync(secretPath, "utf-8").trim();
    if (persisted.length >= 32) return persisted;
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}
