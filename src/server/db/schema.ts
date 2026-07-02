import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

/** Singleton-in-practice: the app only ever lets one row exist (see /setup route). */
export const adminUsers = sqliteTable("admin_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // TOTP 2FA. The secret is stored while enrolling; totpEnabledAt is set only
  // once a first code is verified — its presence means 2FA is active on login.
  totpSecret: text("totp_secret"),
  totpEnabledAt: integer("totp_enabled_at", { mode: "timestamp_ms" }),
  // JSON array of { hash, usedAt } — single-use recovery codes (sha256-hashed,
  // safe because they're high-entropy random, not user-chosen).
  totpBackupCodes: text("totp_backup_codes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

/** DB-backed (not stateless): admin traffic is low-volume, so real per-device revocation is cheap. */
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(), // sha256 hex of the opaque session token; raw token only ever lives in the cookie
    adminId: text("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: timestamp("created_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [index("admin_sessions_admin_id_idx").on(table.adminId)],
);

export const galleries = sqliteTable(
  "galleries",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(), // nanoid(21), ~125 bits entropy — the only externally-facing identifier
    title: text("title").notNull(),
    passwordHash: text("password_hash"), // null = no password
    // Bumped on every password set/change/removal: instantly invalidates all
    // previously issued gallery-access cookies without a server-side session store.
    passwordVersion: integer("password_version").notNull().default(0),
    coverPhotoId: text("cover_photo_id").references((): any => photos.id, { onDelete: "set null" }),
    photoCount: integer("photo_count").notNull().default(0),
    // When true, clients can download originals (per-photo and as zips) —
    // off by default so sharing a link never hands out full-res files
    // unless the photographer opts in.
    allowDownloads: integer("allow_downloads", { mode: "boolean" }).notNull().default(false),
    // Archived galleries are hidden from the default admin list but remain
    // fully accessible by their link — a way to declutter finished shoots.
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    // Optional link lifetime: once past, the public link stops working (admins
    // still have full access). Null = never expires.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("galleries_slug_idx").on(table.slug)],
);

export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(), // nanoid, never sequential — prevents enumeration
    galleryId: text("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    originalFilename: text("original_filename").notNull(), // exactly as uploaded, incl. extension
    // Extension stripped, precomputed at ingest: this is exactly what the
    // Lightroom copy-list exports, so there's zero string work at read time.
    baseFilename: text("base_filename").notNull(),
    fileExt: text("file_ext").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    checksumSha256: text("checksum_sha256").notNull(), // integrity + dedupe-on-reupload
    thumbhash: text("thumbhash"), // base64 placeholder, inlined in grid JSON, zero extra requests
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }), // EXIF DateTimeOriginal, sort fallback
    sortIndex: integer("sort_index").notNull().default(0),
    // This column IS the background job queue — no separate jobs table needed at this scale.
    status: text("status", { enum: ["pending", "processing", "ready", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("photos_gallery_id_idx").on(table.galleryId),
    index("photos_gallery_status_idx").on(table.galleryId, table.status),
    index("photos_gallery_sort_idx").on(table.galleryId, table.sortIndex),
    uniqueIndex("photos_gallery_checksum_idx").on(table.galleryId, table.checksumSha256),
  ],
);

export const favorites = sqliteTable(
  "favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    galleryId: text("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    photoId: text("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    // Provenance only — NOT a partition key. Favorites are a single shared set per
    // gallery (see UNIQUE below): the product needs one consolidated pick list to
    // paste into Lightroom, not per-device lists that "lose" picks across visits.
    toggledByClientToken: text("toggled_by_client_token").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("favorites_gallery_photo_idx").on(table.galleryId, table.photoId),
    index("favorites_gallery_id_idx").on(table.galleryId),
  ],
);

/** Durable, restart-proof brute-force tracking — no Redis, no in-memory counters. */
export const authAttempts = sqliteTable(
  "auth_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope", { enum: ["admin_login", "gallery_unlock"] }).notNull(),
    galleryId: text("gallery_id"),
    ipHash: text("ip_hash").notNull(), // sha256 of the client IP, never raw
    success: integer("success", { mode: "boolean" }).notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("auth_attempts_scope_ip_idx").on(table.scope, table.ipHash, table.createdAt),
    index("auth_attempts_scope_gallery_idx").on(table.scope, table.galleryId, table.createdAt),
  ],
);
