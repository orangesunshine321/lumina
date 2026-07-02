import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

export type DerivedVariant = "thumb" | "thumb2x" | "preview" | "preview2x";
export type DerivedFormat = "webp" | "avif";

const DERIVED_STEMS: Record<DerivedVariant, string> = {
  thumb: "thumb",
  thumb2x: "thumb@2x",
  preview: "preview",
  preview2x: "preview@2x",
};

export function galleryOriginalsDir(galleryId: string): string {
  return join(config.originalsDir, galleryId);
}

export function galleryDerivedDir(galleryId: string): string {
  return join(config.derivedDir, galleryId);
}

export function photoDerivedDir(galleryId: string, photoId: string): string {
  return join(galleryDerivedDir(galleryId), photoId);
}

export function originalPath(galleryId: string, photoId: string, fileExt: string): string {
  return join(galleryOriginalsDir(galleryId), `${photoId}.${fileExt.replace(/^\./, "")}`);
}

export function derivedPath(
  galleryId: string,
  photoId: string,
  variant: DerivedVariant,
  format: DerivedFormat = "webp",
): string {
  return join(photoDerivedDir(galleryId, photoId), `${DERIVED_STEMS[variant]}.${format}`);
}

export async function ensureGalleryDirs(galleryId: string): Promise<void> {
  await mkdir(galleryOriginalsDir(galleryId), { recursive: true });
  await mkdir(galleryDerivedDir(galleryId), { recursive: true });
}

export async function ensurePhotoDerivedDir(galleryId: string, photoId: string): Promise<void> {
  await mkdir(photoDerivedDir(galleryId, photoId), { recursive: true });
}

/** Best-effort recursive delete of everything on disk for a gallery. Safe to
 * call even if some paths don't exist. */
export async function deleteGalleryFiles(galleryId: string): Promise<void> {
  await Promise.all([
    rm(galleryOriginalsDir(galleryId), { recursive: true, force: true }),
    rm(galleryDerivedDir(galleryId), { recursive: true, force: true }),
  ]);
}

const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes upload-staging files orphaned by a crash mid-upload. Anything in
 * tmp/ older than a day can't belong to a live request — normal uploads clean
 * up after themselves on every handled failure path. */
export async function cleanupStaleUploadTmp(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(config.uploadTmpDir);
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  await Promise.all(
    entries.map(async (name) => {
      const path = join(config.uploadTmpDir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // raced with a concurrent delete — fine
      }
    }),
  );
}
