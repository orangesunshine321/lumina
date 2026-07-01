// Shared DTO shapes for the admin and client-facing frontends. Keep these in
// sync with the server route response shapes (src/server/routes/**).

export interface GalleryDTO {
  id: string;
  slug: string;
  title: string;
  hasPassword: boolean;
  coverPhotoId: string | null;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryPublicDTO {
  slug: string;
  title: string;
  requiresPassword: boolean;
  hasAccess: boolean;
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
