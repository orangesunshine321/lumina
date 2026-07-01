import { EventEmitter } from "node:events";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { config } from "../config.ts";
import { originalPath } from "../lib/storage.ts";
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

let started = false;

export function startWorker(): void {
  if (started) return;
  started = true;

  reclaimStuckJobs()
    .catch((err) => console.error("[worker] failed to reclaim stuck jobs", err))
    .finally(() => {
      void loop();
    });
}

async function reclaimStuckJobs(): Promise<void> {
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
  await db
    .update(schema.photos)
    .set({ status: "processing" })
    .where(inArray(schema.photos.id, ids));

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
  try {
    const path = originalPath(photo.galleryId, photo.id, photo.fileExt);
    const result = await processPhoto(path, photo.galleryId, photo.id);

    await db
      .update(schema.photos)
      .set({
        status: "ready",
        width: result.width,
        height: result.height,
        thumbhash: result.thumbhash,
        capturedAt: result.capturedAt,
      })
      .where(eq(schema.photos.id, photo.id));

    progressBus.emit("progress", {
      galleryId: photo.galleryId,
      photoId: photo.id,
      status: "ready",
      width: result.width,
      height: result.height,
      thumbhash: result.thumbhash,
    } satisfies PhotoProgressEvent);
  } catch (err) {
    const attempts = photo.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await db
      .update(schema.photos)
      .set({
        status: failed ? "failed" : "pending",
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.photos.id, photo.id));

    progressBus.emit("progress", {
      galleryId: photo.galleryId,
      photoId: photo.id,
      status: failed ? "failed" : "processing",
    } satisfies PhotoProgressEvent);
  }
}
