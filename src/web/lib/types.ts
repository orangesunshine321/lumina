// Shared DTO shapes for the admin and client-facing frontends. Keep these in
// sync with the server route response shapes (src/server/routes/**).

export interface GalleryDTO {
  id: string;
  slug: string;
  title: string;
  hasPassword: boolean;
  coverPhotoId: string | null;
  photoCount: number;
  favoriteCount: number;
  /** Whether clients may download originals (per-photo and zips). */
  allowDownloads: boolean;
  /** When the client last toggled a favorite — activity signal for the list. */
  lastFavoriteAt: string | null;
  /** Zeroed on the list endpoint; populated on single-gallery GET/PATCH. */
  statusCounts: { pending: number; processing: number; failed: number };
  /** Total bytes of originals; zeroed on the list endpoint. */
  originalsBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryPublicDTO {
  slug: string;
  title: string;
  requiresPassword: boolean;
  hasAccess: boolean;
  /** Count of ready (client-visible) photos. 0 until access is granted. */
  photoCount: number;
  favoriteCount: number;
  /** Downloads opt-in; false until access is granted. */
  allowDownloads: boolean;
  /** Cover photo for the hero header; null until access is granted. */
  coverPhotoId: string | null;
}

export interface SystemStatsDTO {
  version: string;
  backup: { lastBackupAt: string | null; isStale: boolean };
  disk: { totalBytes: number; freeBytes: number; lowSpace: boolean };
  database: { sizeBytes: number };
  library: { galleries: number; photos: number; originalsBytes: number };
  queue: { pending: number; processing: number; failed: number };
}

export type PhotoStatus = "pending" | "processing" | "ready" | "failed";

export interface PhotoUrls {
  thumb: string;
  thumb2x: string;
  preview: string;
  preview2x: string;
  original: string;
}

export interface PhotoDTO {
  id: string;
  originalFilename: string;
  baseFilename: string;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  status: PhotoStatus;
  sortIndex: number;
  favorited?: boolean;
  urls: PhotoUrls;
}

export interface PhotoListResponse {
  photos: PhotoDTO[];
  nextCursor: string | null;
}

export interface FavoriteToggleResponse {
  favorited: boolean;
}

export interface LightroomListResponse {
  count: number;
  filenames: string[];
  text: string;
}

/** Builds the photo-byte-serving URL for a given variant. Always use this
 * instead of constructing the path inline, so every consumer stays in sync
 * with the server route in src/server/routes/photos.ts. */
export function photoUrl(photoId: string, variant: keyof PhotoUrls): string {
  return `/api/photos/${photoId}/${variant}`;
}
