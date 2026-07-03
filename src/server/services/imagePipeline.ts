import { rm } from "node:fs/promises";
import sharp from "sharp";
import exifr from "exifr";
import { rgbaToThumbHash } from "thumbhash";
import { config } from "../config.ts";
import { derivedPath, ensurePhotoDerivedDir, type DerivedVariant } from "../lib/storage.ts";

const DERIVATIVE_SPECS: Record<DerivedVariant, { size: number; quality: number }> = {
  thumb: { size: 480, quality: 80 },
  thumb2x: { size: 960, quality: 80 },
  preview: { size: 1600, quality: 85 },
  preview2x: { size: 2400, quality: 85 },
};

// AVIF is generated only for the grid thumbnails. They load in bulk (so AVIF's
// smaller bytes matter most there) and are cheap+fast to encode. The large
// preview AVIFs were the opposite: slow, and memory-hungry enough that four
// concurrent photos could exhaust a modest container and stall the whole queue.
// The lightbox serves previews as WebP (few images, one at a time) via the
// serve route's per-variant format fallback, so nothing breaks.
const AVIF_VARIANTS = new Set<DerivedVariant>(["thumb", "thumb2x"]);

// Belt-and-braces cap so a single pathological image can't wedge a libvips
// operation forever (the worker also enforces a per-photo wall-clock timeout).
const SHARP_TIMEOUT_SECONDS = 60;

/** Every sharp() in the pipeline goes through here so `limitInputPixels` is
 * always armed — sharp throws rather than decoding a decompression bomb into
 * memory. The upload route rejects oversized images earlier; this backstops
 * anything already on disk (e.g. a re-processed original). */
function openImage(path: string, maxPixels: number) {
  return sharp(path, { limitInputPixels: maxPixels }).timeout({ seconds: SHARP_TIMEOUT_SECONDS });
}

export interface ProcessedPhoto {
  width: number | null;
  height: number | null;
  thumbhash: string;
  capturedAt: Date | null;
}

export interface ProcessOptions {
  generateAvif?: boolean;
  maxImagePixels?: number;
}

/** Generates the four WebP derivatives, a ThumbHash placeholder, and reads
 * EXIF capture time for one original JPEG. Throws on genuine failure (e.g. a
 * corrupt file) so the caller can mark the job failed and retry. AVIF/pixel
 * behavior comes from live settings (opts); absent, it falls back to config. */
export async function processPhoto(
  originalPath: string,
  galleryId: string,
  photoId: string,
  opts: ProcessOptions = {},
): Promise<ProcessedPhoto> {
  const generateAvif = opts.generateAvif ?? config.generateAvif;
  const maxImagePixels = opts.maxImagePixels ?? config.maxImagePixels;
  await ensurePhotoDerivedDir(galleryId, photoId);

  const meta = await openImage(originalPath, maxImagePixels).metadata();
  const orientation = meta.orientation ?? 1;
  const swapped = orientation >= 5 && orientation <= 8;
  // null (not 0) when sharp can't report a dimension: the frontend's
  // `?? fallback` guards catch null, but a 0 would flow into the justified-
  // layout math as a zero-width photo and produce NaN row heights.
  const width = (swapped ? meta.height : meta.width) || null;
  const height = (swapped ? meta.width : meta.height) || null;

  await Promise.all(
    (Object.keys(DERIVATIVE_SPECS) as DerivedVariant[]).map(async (variant) => {
      const { size, quality } = DERIVATIVE_SPECS[variant];
      // A single decode+resize pipeline, cloned per output format so the
      // source is read once. .rotate() auto-orients from EXIF then strips the
      // tag; withoutEnlargement keeps tiny originals from being upscaled.
      const resized = openImage(originalPath, maxImagePixels)
        .rotate()
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });

      await resized
        .clone()
        .webp({ quality })
        .toFile(derivedPath(galleryId, photoId, variant, "webp"));

      if (generateAvif && AVIF_VARIANTS.has(variant)) {
        // AVIF is a best-effort optimization: the serve route falls back to
        // WebP whenever the .avif file is absent (see routes/photos.ts), so a
        // failed AVIF encode must NOT fail the whole photo — otherwise a valid
        // photo whose WebP already wrote fine would exhaust retries and be
        // hidden forever. The AVIF encoder (libheif/aom) is materially more
        // fragile than WebP (tiny/odd derivative dimensions, higher memory), so
        // swallow its errors and leave the photo served as WebP.
        // effort 3 keeps encodes quick on modest hardware; AVIF quality maps a
        // bit lower than WebP for the same visual result.
        const avifPath = derivedPath(galleryId, photoId, variant, "avif");
        try {
          await resized.clone().avif({ quality: quality - 5, effort: 3 }).toFile(avifPath);
        } catch (err) {
          console.warn(
            `[imagePipeline] AVIF encode failed for ${photoId} (${variant}); serving WebP only:`,
            err instanceof Error ? err.message : err,
          );
          // Remove any partial/truncated .avif so the serve route's file-exists
          // check falls back to WebP instead of streaming a broken AVIF.
          await rm(avifPath, { force: true });
        }
      }
    }),
  );

  const thumbhash = await computeThumbHash(originalPath, maxImagePixels);
  const capturedAt = await readCapturedAt(originalPath);

  return { width, height, thumbhash, capturedAt };
}

async function computeThumbHash(originalPath: string, maxPixels: number): Promise<string> {
  const { data, info } = await openImage(originalPath, maxPixels)
    .rotate()
    .resize({ width: 100, height: 100, fit: "inside", withoutEnlargement: true })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString("base64");
}

async function readCapturedAt(originalPath: string): Promise<Date | null> {
  try {
    const exif = await exifr.parse(originalPath, { pick: ["DateTimeOriginal"] });
    const value = exif?.DateTimeOriginal;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    return null;
  } catch {
    return null;
  }
}
