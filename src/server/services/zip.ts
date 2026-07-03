import { ZipArchive } from "archiver";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { originalPath } from "../lib/storage.ts";

// Zip building reads every original off disk and streams it out. Cap how many
// run at once so a client (or a scripted link) can't exhaust CPU/disk/upload
// bandwidth by firing many "download all" requests in parallel.
const MAX_CONCURRENT_ZIPS = 3;
let activeZips = 0;

export interface ZipEntry {
  galleryId: string;
  photoId: string;
  fileExt: string;
  originalFilename: string;
  /** Subfolder inside the zip (a set's title); null = the archive root. */
  folder: string | null;
}

export interface CollectOpts {
  galleryId: string;
  scope: "all" | "favorites" | "set";
  /** Required for scope="set" — the target set (or the string "ungrouped"). */
  setId?: string;
  /** Client view: exclude photos in sets that aren't visible to the client. */
  visibleOnly?: boolean;
  /** Client view: exclude photos the client isn't allowed to download. */
  downloadableOnly?: boolean;
  /** Governs whether UNGROUPED photos count as downloadable (the gallery-level
   * gate) when downloadableOnly is set. */
  galleryAllowDownloads?: boolean;
  /** Namespace each entry under its set's title (for multi-set archives). */
  folderBySet?: boolean;
}

/**
 * Resolve the exact set of originals a download should contain, applying set
 * visibility/download permissions in ONE place. Returns rows ordered by set
 * then photo, each tagged with the set title so the streamer can foldernamespace.
 */
export async function collectZipEntries(opts: CollectOpts): Promise<ZipEntry[]> {
  const conditions = [eq(schema.photos.galleryId, opts.galleryId), eq(schema.photos.status, "ready")];

  if (opts.scope === "set") {
    if (opts.setId === "ungrouped") {
      conditions.push(isNull(schema.photos.setId));
    } else if (opts.setId) {
      conditions.push(eq(schema.photos.setId, opts.setId));
    }
  }

  if (opts.visibleOnly) {
    // Ungrouped photos are always visible; set photos only if the set is visible.
    conditions.push(or(isNull(schema.photos.setId), eq(schema.photoSets.visibleToClient, true))!);
  }

  if (opts.downloadableOnly) {
    conditions.push(
      or(
        // Ungrouped → governed by the gallery-level toggle.
        opts.galleryAllowDownloads ? isNull(schema.photos.setId) : sql`0`,
        // In a set → must be both visible and downloadable.
        and(eq(schema.photoSets.visibleToClient, true), eq(schema.photoSets.allowDownloads, true)),
      )!,
    );
  }

  const cols = {
    photoId: schema.photos.id,
    galleryId: schema.photos.galleryId,
    fileExt: schema.photos.fileExt,
    originalFilename: schema.photos.originalFilename,
    setTitle: schema.photoSets.title,
    setSortIndex: schema.photoSets.sortIndex,
    photoSortIndex: schema.photos.sortIndex,
  };

  const rows =
    opts.scope === "favorites"
      ? await db
          .select(cols)
          .from(schema.favorites)
          .innerJoin(
            schema.photos,
            and(eq(schema.favorites.photoId, schema.photos.id), eq(schema.photos.status, "ready")),
          )
          .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
          .where(and(eq(schema.favorites.galleryId, opts.galleryId), ...conditions))
          .orderBy(asc(schema.photoSets.sortIndex), asc(schema.photos.sortIndex))
      : await db
          .select(cols)
          .from(schema.photos)
          .leftJoin(schema.photoSets, eq(schema.photoSets.id, schema.photos.setId))
          .where(and(...conditions))
          .orderBy(asc(schema.photoSets.sortIndex), asc(schema.photos.sortIndex));

  return rows.map((r) => ({
    galleryId: r.galleryId,
    photoId: r.photoId,
    fileExt: r.fileExt,
    originalFilename: r.originalFilename,
    folder: opts.folderBySet ? r.setTitle : null,
  }));
}

/**
 * Streams a zip of the given originals. Entries with a `folder` are namespaced
 * under a sanitized subfolder, with filename-collision dedup scoped PER folder
 * (so Raws/IMG_001.jpg and Finals/IMG_001.jpg coexist without spurious "(2)"
 * suffixes). Returns false when there's nothing to include, so the caller can
 * send a friendly error instead of an empty archive.
 */
export async function streamPhotoZip(
  request: FastifyRequest,
  reply: FastifyReply,
  filenameBase: string,
  entries: ZipEntry[],
): Promise<boolean> {
  if (entries.length === 0) return false;

  if (activeZips >= MAX_CONCURRENT_ZIPS) {
    reply.code(503).header("Retry-After", "10").send({ error: "busy" });
    return true; // handled (rejected) — caller must not also respond
  }
  activeZips += 1;

  const filename = `${slugify(filenameBase)}.zip`;

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });

  // Source files are already-compressed JPEGs — store them verbatim.
  const archive = new ZipArchive({ store: true });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeZips = Math.max(0, activeZips - 1);
  };
  reply.raw.on("close", release);
  archive.on("error", (err: Error) => {
    request.log.error({ err }, "zip archive error");
    reply.raw.destroy(err);
  });
  // archiver emits a non-fatal 'warning' (not 'error') when a queued file can't
  // be stat'd — e.g. a 'ready' photo whose original is missing on disk. Without
  // a listener that's silently swallowed and the client gets a 200 zip with
  // fewer files than expected. Log it so the gap is at least visible in ops.
  archive.on("warning", (err: Error) => {
    request.log.warn({ err }, "zip archive warning (a file was skipped)");
  });
  archive.pipe(reply.raw);

  // Dedup filenames PER folder: different photos can share an original filename
  // (same camera, two cards), and identical zip entry names silently overwrite
  // on extract — but the same name in two different set folders is fine.
  const usedByFolder = new Map<string, Set<string>>();
  for (const entry of entries) {
    const folder = entry.folder ? sanitizeFolder(entry.folder) : "";
    let used = usedByFolder.get(folder);
    if (!used) {
      used = new Set<string>();
      usedByFolder.set(folder, used);
    }
    const base = uniqueEntryName(entry.originalFilename, used);
    const name = folder ? `${folder}/${base}` : base;
    archive.file(originalPath(entry.galleryId, entry.photoId, entry.fileExt), { name });
  }

  try {
    await archive.finalize();
  } finally {
    // `close` covers client disconnects; this covers normal completion. The
    // slot is released once either fires (release is idempotent-ish via max).
    release();
    reply.raw.off("close", release);
  }
  return true;
}

function uniqueEntryName(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot > 0 ? filename.slice(lastDot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** A zip filename (no folder separators, no control chars). */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "gallery";
}

/** A safe, human-readable subfolder name inside the archive — keeps spaces and
 * case (unlike slugify) but strips path separators / control chars. */
function sanitizeFolder(title: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "Set";
}
