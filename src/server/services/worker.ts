import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { config } from "../config.ts";
import { originalPath, photoDerivedDir } from "../lib/storage.ts";
import { processPhoto } from "./imagePipeline.ts";

export interface PhotoProgressEvent {
  galleryId: string;
  photoId: string;
  status: "processing" | "ready" | "failed";
  width?: number;
  height?: number;
  thumbhash?: string;
}

/** Emits a PhotoProgressEvent on every status change; SSE routes subscribe
 * and filter by galleryId. */
export const progressBus = new EventEmitter();
progressBus.setMaxListeners(50);

const POLL_IDLE_DELAY_MS = 2000;
const MAX_ATTEMPTS = 5;
// Per-photo wall-clock ceiling. Normal photos process in a second or two; this
// only trips on a genuine hang so one bad image can't wedge the whole queue —
// on timeout the photo is treated as a failed attempt and the worker moves on.
const PROCESS_TIMEOUT_MS = 90_000;

/** Rejects if the wrapped work hasn't settled within `ms`. The underlying sharp
 * op may keep running briefly in the background, but the queue is freed. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`processing timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let started = false;

export function startWorker(): void {
  if (started) return;
  started = true;

  console.log(`[worker] starting (concurrency=${config.uploadConcurrency}, avif=${config.generateAvif})`);
  reclaimStuckJobs()
    .catch((err) => console.error("[worker] failed to reclaim stuck jobs", err))
    .finally(() => {
      void loop();
    });
}

async function reclaimStuckJobs(): Promise<void> {
  // A row still 'processing' at boot means the worker died mid-job — the kind
  // of failure (OOM/SIGKILL, a native libvips segfault) the in-JS catch below
  // never sees. Because `attempts` is bumped at CLAIM time (see runBatch), such
  // a crash still counts as an attempt, so a poison-pill image that repeatedly
  // hard-crashes the process gets quarantined here after MAX_ATTEMPTS instead
  // of being reprocessed forever — otherwise it's a permanent boot/crash-flap
  // loop that wedges the whole queue. Everything under the cap goes back to the
  // pending pool to be retried.
  await db
    .update(schema.photos)
    .set({ status: "failed", lastError: "processing crashed the worker (max attempts reached)" })
    .where(and(eq(schema.photos.status, "processing"), gte(schema.photos.attempts, MAX_ATTEMPTS)));

  await db
    .update(schema.photos)
    .set({ status: "pending" })
    .where(eq(schema.photos.status, "processing"));
}

async function loop(): Promise<void> {
  let didWork = false;
  try {
    didWork = await runBatch();
  } catch (err) {
    console.error("[worker] batch failed", err);
  }
  setTimeout(() => void loop(), didWork ? 0 : POLL_IDLE_DELAY_MS);
}

async function runBatch(): Promise<boolean> {
  const pending = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.status, "pending"))
    .orderBy(asc(schema.photos.createdAt))
    .limit(config.uploadConcurrency);

  if (pending.length === 0) return false;

  const ids = pending.map((p) => p.id);
  // Bump attempts as part of the claim, BEFORE any processing runs, so an
  // attempt is recorded even when the work kills the process outright (OOM /
  // native crash) and the catch handler never runs. reclaimStuckJobs relies on
  // this to eventually quarantine a poison-pill image instead of looping on it.
  await db
    .update(schema.photos)
    .set({ status: "processing", attempts: sql`${schema.photos.attempts} + 1` })
    .where(inArray(schema.photos.id, ids));

  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.photos)
    .where(eq(schema.photos.status, "pending"));
  console.log(
    `[worker] processing ${pending.length} photo(s); ${remaining?.count ?? 0} still queued`,
  );

  for (const photo of pending) {
    progressBus.emit("progress", {
      galleryId: photo.galleryId,
      photoId: photo.id,
      status: "processing",
    } satisfies PhotoProgressEvent);
  }

  await Promise.all(pending.map((photo) => processOne(photo)));
  return true;
}

async function processOne(photo: typeof schema.photos.$inferSelect): Promise<void> {
  const startedAt = Date.now();
  try {
    const path = originalPath(photo.galleryId, photo.id, photo.fileExt);
    const result = await withTimeout(processPhoto(path, photo.galleryId, photo.id), PROCESS_TIMEOUT_MS);

    const [updatedRow] = await db
      .update(schema.photos)
      .set({
        status: "ready",
        width: result.width,
        height: result.height,
        thumbhash: result.thumbhash,
        capturedAt: result.capturedAt,
      })
      .where(eq(schema.photos.id, photo.id))
      .returning({ id: schema.photos.id });

    // Zero rows updated means the gallery (and this photo, via cascade) was
    // deleted while we were processing. deleteGalleryFiles already ran and then
    // processPhoto recreated the derived dir and wrote into it — remove those
    // now-orphaned files instead of leaving them behind, and skip the rest.
    if (!updatedRow) {
      await rm(photoDerivedDir(photo.galleryId, photo.id), { recursive: true, force: true }).catch(() => {});
      await rm(originalPath(photo.galleryId, photo.id, photo.fileExt), { force: true }).catch(() => {});
      return;
    }

    // First photo to finish processing becomes the gallery cover (admin
    // gallery cards render it); the photographer can't pick one yet, so
    // "first ready" is the sensible default.
    await db
      .update(schema.galleries)
      .set({ coverPhotoId: photo.id })
      .where(and(eq(schema.galleries.id, photo.galleryId), isNull(schema.galleries.coverPhotoId)));

    progressBus.emit("progress", {
      galleryId: photo.galleryId,
      photoId: photo.id,
      status: "ready",
      width: result.width ?? undefined,
      height: result.height ?? undefined,
      thumbhash: result.thumbhash,
    } satisfies PhotoProgressEvent);
    console.log(`[worker] ✓ ${photo.originalFilename} ready in ${Date.now() - startedAt}ms`);
  } catch (err) {
    // attempts was already incremented at claim time (runBatch), so the row's
    // current count is photo.attempts + 1 — don't bump it again here, just
    // decide whether this graceful failure exhausted the retry budget.
    const attempts = photo.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await db
      .update(schema.photos)
      .set({
        status: failed ? "failed" : "pending",
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.photos.id, photo.id));

    progressBus.emit("progress", {
      galleryId: photo.galleryId,
      photoId: photo.id,
      status: failed ? "failed" : "processing",
    } satisfies PhotoProgressEvent);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] ✗ ${photo.originalFilename} ${failed ? "FAILED permanently" : "errored, will retry"} ` +
        `after ${Date.now() - startedAt}ms (attempt ${attempts}/${MAX_ATTEMPTS}): ${msg}`,
    );
  }
}
