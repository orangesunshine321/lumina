import { stat } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import { thumbHashToDataURL } from "thumbhash";
import {
  cleanupDataDir,
  ensureGalleryDirs,
  ensurePhotoDerivedDir,
  originalPath,
  derivedPath,
  sqlite,
} from "./helpers.ts";

const GALLERY_ID = "test-gallery-pipeline";
const PHOTO_ID = "test-photo-pipeline";

let result: Awaited<ReturnType<(typeof import("../services/imagePipeline.ts"))["processPhoto"]>>;

beforeAll(async () => {
  await ensureGalleryDirs(GALLERY_ID);
  await ensurePhotoDerivedDir(GALLERY_ID, PHOTO_ID);

  const source = originalPath(GALLERY_ID, PHOTO_ID, "jpg");
  await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 80, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toFile(source);

  const { processPhoto } = await import("../services/imagePipeline.ts");
  result = await processPhoto(source, GALLERY_ID, PHOTO_ID);
}, 30_000);

afterAll(() => {
  sqlite.close();
  cleanupDataDir();
});

describe("imagePipeline", () => {
  it("reports the original dimensions", () => {
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it("writes all four WebP derivatives", async () => {
    for (const variant of ["thumb", "thumb2x", "preview", "preview2x"] as const) {
      const info = await stat(derivedPath(GALLERY_ID, PHOTO_ID, variant));
      expect(info.size).toBeGreaterThan(0);
    }
  });

  it("derivatives never exceed their size caps or the original", async () => {
    const thumb = await sharp(derivedPath(GALLERY_ID, PHOTO_ID, "thumb")).metadata();
    expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBeLessThanOrEqual(480);
    // Original is 800px wide — withoutEnlargement must cap preview2x at 800.
    const preview2x = await sharp(derivedPath(GALLERY_ID, PHOTO_ID, "preview2x")).metadata();
    expect(Math.max(preview2x.width ?? 0, preview2x.height ?? 0)).toBeLessThanOrEqual(800);
  });

  it("produces a decodable base64 ThumbHash", () => {
    expect(result.thumbhash.length).toBeGreaterThan(0);
    const bytes = Uint8Array.from(Buffer.from(result.thumbhash, "base64"));
    const dataUrl = thumbHashToDataURL(bytes);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("returns null capturedAt for a JPEG without EXIF", () => {
    expect(result.capturedAt).toBeNull();
  });
});
