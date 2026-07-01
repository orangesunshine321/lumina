import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

export type DerivedVariant = "thumb" | "thumb2x" | "preview" | "preview2x";

const DERIVED_FILENAMES: Record<DerivedVariant, string> = {
  thumb: "thumb.webp",
  thumb2x: "thumb@2x.webp",
  preview: "preview.webp",
  preview2x: "preview@2x.webp",
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

export function derivedPath(galleryId: string, photoId: string, variant: DerivedVariant): string {
  return join(photoDerivedDir(galleryId, photoId), DERIVED_FILENAMES[variant]);
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
