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

/** Every sharp() in the pipeline goes through here so `limitInputPixels` is
 * always armed — sharp throws rather than decoding a decompression bomb into
 * memory. The upload route rejects oversized images earlier; this backstops
 * anything already on disk (e.g. a re-processed original). */
function openImage(path: string) {
  return sharp(path, { limitInputPixels: config.maxImagePixels });
}

export interface ProcessedPhoto {
  width: number | null;
  height: number | null;
  thumbhash: string;
  capturedAt: Date | null;
}

/** Generates the four WebP derivatives, a ThumbHash placeholder, and reads
 * EXIF capture time for one original JPEG. Throws on genuine failure (e.g. a
 * corrupt file) so the caller can mark the job failed and retry. */
export async function processPhoto(
  originalPath: string,
  galleryId: string,
  photoId: string,
): Promise<ProcessedPhoto> {
  await ensurePhotoDerivedDir(galleryId, photoId);

  const meta = await openImage(originalPath).metadata();
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
      const resized = openImage(originalPath)
        .rotate()
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });

      await resized
        .clone()
        .webp({ quality })
        .toFile(derivedPath(galleryId, photoId, variant, "webp"));

      if (config.generateAvif) {
        // effort 4 balances encode speed against size; AVIF quality maps a bit
        // lower than WebP for the same visual result.
        await resized
          .clone()
          .avif({ quality: quality - 5, effort: 4 })
          .toFile(derivedPath(galleryId, photoId, variant, "avif"));
      }
    }),
  );

  const thumbhash = await computeThumbHash(originalPath);
  const capturedAt = await readCapturedAt(originalPath);

  return { width, height, thumbhash, capturedAt };
}

async function computeThumbHash(originalPath: string): Promise<string> {
  const { data, info } = await openImage(originalPath)
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
