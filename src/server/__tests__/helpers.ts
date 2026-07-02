/**
 * Shared test bootstrap. MUST be the first import in every test file: its
 * module body points DATA_DIR at a fresh temp dir and sets NODE_ENV/SESSION_SECRET
 * BEFORE config.ts or db/client.ts (which read env at import time) are loaded.
 * Vitest isolates module registries per test file, so each file gets its own
 * temp dir, its own SQLite database, and its own app instance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dataDir = mkdtempSync(join(tmpdir(), "pixset-test-"));
process.env.DATA_DIR = dataDir;
// Production mode: avoids the pino-pretty worker-thread transport and matches
// the deployed configuration. Requires an explicit SESSION_SECRET.
process.env.NODE_ENV = "production";
process.env.SESSION_SECRET = "test-secret-0123456789abcdef0123456789abcdef0123456789abcdef";

const dbModule = await import("../db/client.ts");
export const db = dbModule.db;
export const sqlite = dbModule.sqlite;
export const schema = dbModule.schema;

const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
migrate(db, { migrationsFolder: "./drizzle" });

export const { originalPath, derivedPath, ensureGalleryDirs, ensurePhotoDerivedDir } = await import(
  "../lib/storage.ts"
);
export const { generateId } = await import("../lib/ids.ts");

export type App = Awaited<ReturnType<(typeof import("../app.ts"))["buildApp"]>>;

export async function createApp(): Promise<App> {
  const { buildApp } = await import("../app.ts");
  return buildApp();
}

export const ADMIN_EMAIL = "admin@test.dev";
export const ADMIN_PASSWORD = "test-password-123";
export const ADMIN_COOKIE = "pixset_admin_session";

interface InjectResponseLike {
  cookies: Array<{ name: string; value: string }>;
}

export function cookieValue(res: InjectResponseLike, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

export async function setupAdmin(app: App): Promise<{ adminCookie: string }> {
  const { ensureSetupToken } = await import("../services/setupToken.ts");
  const res = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, setupToken: ensureSetupToken() },
  });
  if (res.statusCode !== 200) {
    throw new Error(`test setup failed: ${res.statusCode} ${res.body}`);
  }
  return { adminCookie: cookieValue(res, ADMIN_COOKIE)! };
}

export async function createGallery(
  app: App,
  adminCookie: string,
  title = "Test Gallery",
): Promise<{ id: string; slug: string; title: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/galleries",
    payload: { title },
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
  if (res.statusCode !== 201) {
    throw new Error(`test gallery creation failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

let photoCounter = 0;

/** Inserts a photo row directly (no bytes on disk) — enough for list/favorite/
 * export routes, which never touch the filesystem. */
export async function insertReadyPhoto(
  galleryId: string,
  overrides: Partial<typeof schema.photos.$inferInsert> = {},
) {
  photoCounter += 1;
  const id = generateId();
  const [row] = await db
    .insert(schema.photos)
    .values({
      id,
      galleryId,
      originalFilename: `DSC_${1000 + photoCounter}.jpg`,
      baseFilename: `DSC_${1000 + photoCounter}`,
      fileExt: "jpg",
      byteSize: 1234,
      checksumSha256: `checksum-${photoCounter}-${id}`,
      status: "ready",
      sortIndex: photoCounter,
      ...overrides,
    })
    .returning();
  return row!;
}

export async function unlockGallery(app: App, slug: string, galleryId: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/gallery/${slug}/unlock`,
    payload: { password },
  });
  return { res, cookie: cookieValue(res, `pixset_gallery_${galleryId}`) };
}

export function multipartUpload(filename: string, contentType: string, data: Buffer) {
  const boundary = "----pixsetTestBoundary42";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

export function cleanupDataDir() {
  rmSync(dataDir, { recursive: true, force: true });
}
