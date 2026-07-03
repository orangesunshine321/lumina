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
  archivedAt: string | null;
  expiresAt: string | null;
  /** Set when the client submitted their picks; cleared when marked reviewed. */
  selectionSubmittedAt: string | null;
  selectionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryPublicDTO {
  slug: string;
  title: string;
  requiresPassword: boolean;
  hasAccess: boolean;
  /** True when the gallery link has passed its expiry. */
  expired: boolean;
  /** Count of ready (client-visible) photos. 0 until access is granted. */
  photoCount: number;
  favoriteCount: number;
  /** Downloads opt-in; false until access is granted. */
  allowDownloads: boolean;
  /** How many of the client's favorites are actually downloadable (respecting
   * per-set permissions) — gates the "Download favorites" option. */
  downloadableFavoriteCount: number;
  /** Cover photo for the hero header; null until access is granted. */
  coverPhotoId: string | null;
  /** When the client last submitted their selection (past the gate); null if never. */
  selectionSubmittedAt: string | null;
  /** Client-visible sets (empty when the gallery uses no sets). */
  sets: PublicSetDTO[];
  /** Ready photos in no set — the default/"Unsorted" grouping. */
  ungroupedCount: number;
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
  /** The set this photo belongs to, or null if ungrouped. */
  setId: string | null;
  favorited?: boolean;
  urls: PhotoUrls;
}

/** A photo set as the admin manages it (both client-facing toggles visible). */
export interface SetDTO {
  id: string;
  title: string;
  sortIndex: number;
  visibleToClient: boolean;
  allowDownloads: boolean;
  photoCount: number;
  createdAt: string;
}

export interface SetsResponse {
  sets: SetDTO[];
  ungroupedCount: number;
}

/** A client-visible set on the public gallery landing (no hidden ones, no
 * visibility flag — the client only ever sees sets it's allowed to). */
export interface PublicSetDTO {
  id: string;
  title: string;
  allowDownloads: boolean;
  photoCount: number;
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

/** Operator-tunable app settings, editable from the admin panel and the setup
 * screen (mirrors src/server/services/settings.ts). */
export interface AppSettings {
  generateAvif: boolean;
  uploadConcurrency: number;
  maxUploadFileSizeBytes: number;
  maxImagePixels: number;
  /** Canonical public origin for shareable links (e.g. https://gallery.example.com);
   * "" means fall back to the browser's current origin. */
  publicBaseUrl: string;
}

export interface SettingsLimits {
  uploadConcurrency: { min: number; max: number };
  maxUploadFileSizeBytes: { min: number; max: number };
  maxImagePixels: { min: number; max: number };
}

export interface SettingsResponse {
  settings: AppSettings;
  limits: SettingsLimits;
}

// --- Public-access wizard (networking / custom domain) ---------------------

export interface ProxyDiagnostics {
  publicBaseUrl: string;
  observedHost: string | null;
  observedProto: string | null;
  forwardedFor: string | null;
  cfConnectingIp: string | null;
  cfRay: string | null;
  via: string | null;
  behindProxy: boolean;
  behindCloudflare: boolean;
  httpsUpstream: boolean;
  trustProxy: boolean;
  secureCookies: boolean;
  clientIp: string;
}

export interface NetworkStatusResponse {
  diagnostics: ProxyDiagnostics;
}

export interface SelfTestResult {
  ok: boolean;
  url: string;
  reachable: boolean;
  status: number | null;
  https: boolean;
  matchedThisInstance: boolean;
  error: string | null;
  durationMs: number;
}

export interface CloudflareZone {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
}

export interface CloudflareVerifyResponse {
  accounts: { id: string; name: string }[];
  zones: CloudflareZone[];
}

export interface CloudflareProvisionResult {
  hostname: string;
  zoneName: string;
  tunnelId: string;
  tunnelName: string;
  tunnelToken: string;
  publicBaseUrl: string;
  envLine: string;
  command: string;
}

/** Builds the photo-byte-serving URL for a given variant. Always use this
 * instead of constructing the path inline, so every consumer stays in sync
 * with the server route in src/server/routes/photos.ts. */
export function photoUrl(photoId: string, variant: keyof PhotoUrls): string {
  return `/api/photos/${photoId}/${variant}`;
}
