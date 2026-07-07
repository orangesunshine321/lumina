import { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import { api } from "../../../lib/api.ts";
import { UploadTray } from "./UploadTray.tsx";

/**
 * A single, app-global upload manager. It lives above the admin route tree (see
 * AdminApp), so an upload keeps running — and keeps showing progress in the
 * floating tray — as you navigate between galleries, instead of dying when the
 * gallery page unmounts. One Uppy instance processes batches SERIALLY (one
 * gallery at a time); starting an upload for another gallery just queues it,
 * which keeps each file routed to the right endpoint with no cross-talk.
 */

export type BatchStatus = "queued" | "checking" | "uploading" | "done";

export interface UploadFailure {
  name: string;
  reason: string;
}

export interface UploadBatch {
  id: string;
  galleryId: string;
  galleryTitle: string;
  setId: string | null;
  status: BatchStatus;
  /** Files that will actually be sent (after dedup). */
  total: number;
  done: number;
  failed: number;
  /** Skipped because they're already in the gallery (dedup). */
  skipped: number;
  /** Rejected client-side for not being a JPEG. */
  nonJpeg: number;
  progressPct: number;
  failures: UploadFailure[];
}

interface EnqueueInput {
  galleryId: string;
  galleryTitle: string;
  setId: string | null;
  files: File[];
}

interface UploadManagerValue {
  enqueue: (input: EnqueueInput) => void;
  dismiss: (batchId: string) => void;
  clearFinished: () => void;
  batches: UploadBatch[];
}

const Ctx = createContext<UploadManagerValue | null>(null);

export function useUploadManager(): UploadManagerValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useUploadManager must be used within an UploadManagerProvider");
  return value;
}

/** Maps the server's machine-readable upload errors to something actionable. */
function uploadErrorMessage(xhr: XMLHttpRequest): string {
  if (xhr.status === 401) return "Your session expired — sign in again, then retry the upload.";
  let code: string | undefined;
  try {
    code = (JSON.parse(xhr.responseText) as { error?: string }).error;
  } catch {
    // non-JSON body — fall through to the generic message
  }
  if (code === "invalid_file_type") return "Not a JPEG — export as JPEG and try again.";
  if (code === "file_too_large") return "File is too large.";
  if (code === "image_too_large") return "Image resolution is too high.";
  if (code === "invalid_set") return "That set no longer exists.";
  if (xhr.status >= 500) return "Server error — try again.";
  return `Upload failed (HTTP ${xhr.status}).`;
}

const isJpeg = (name: string) => /\.jpe?g$/i.test(name);

let seq = 0;
const nextId = () => `batch-${++seq}`;

export function UploadManagerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Source of truth is a ref (Uppy callbacks read/write it with no staleness);
  // `bump` forces the tray to re-render on every change.
  const batchesRef = useRef<UploadBatch[]>([]);
  const filesRef = useRef<Map<string, File[]>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const lastInvalidateRef = useRef(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const commit = () => bump();

  // Latest-callback ref: Uppy event listeners are registered ONCE (below) but
  // always call the freshest logic, so they never capture stale closures.
  const logicRef = useRef<{
    onProgress: (pct: number) => void;
    onSuccess: () => void;
    onError: (name: string, message: string) => void;
    onComplete: (result: { successful?: { id: string }[]; failed?: { id: string }[] }) => void;
  } | null>(null);

  const [uppy] = useState(() => {
    // No allowedFileTypes: some valid camera JPEGs arrive with an empty MIME
    // type; we filter by extension in enqueue and the server validates the real
    // header. Uploads are started explicitly per batch.
    const instance = new Uppy({ autoProceed: false }).use(XHRUpload, {
      endpoint: "/api/admin/uploads/pending", // replaced per-batch before each upload
      fieldName: "file",
      bundle: false,
      // More parallel streams keep a high-latency link (e.g. a tunnel/VPN to a
      // cloud box) fuller; the server accepts each independently.
      limit: 8,
      withCredentials: true,
      shouldRetry: (xhr) => xhr.status === 0 || xhr.status >= 500,
      onAfterResponse: (xhr) => {
        if (xhr.status >= 200 && xhr.status < 300) return;
        throw new Error(uploadErrorMessage(xhr));
      },
    });
    instance.on("progress", (pct: number) => logicRef.current?.onProgress(pct));
    instance.on("upload-success", () => logicRef.current?.onSuccess());
    instance.on("upload-error", (file, error) =>
      logicRef.current?.onError(file?.name ?? "file", error?.message ?? "Upload failed."),
    );
    instance.on("complete", (result) => logicRef.current?.onComplete(result as never));
    return instance;
  });

  function patchActive(patch: Partial<UploadBatch> | ((b: UploadBatch) => Partial<UploadBatch>)) {
    const id = activeIdRef.current;
    if (!id) return;
    batchesRef.current = batchesRef.current.map((b) =>
      b.id === id ? { ...b, ...(typeof patch === "function" ? patch(b) : patch) } : b,
    );
    commit();
  }

  function invalidateGallery(galleryId: string) {
    queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
    queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
    queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
    queryClient.invalidateQueries({ queryKey: ["admin-sets", galleryId] });
  }

  // --- Uppy event logic (kept fresh via logicRef) --------------------------
  function onProgress(pct: number) {
    patchActive({ progressPct: pct });
  }
  function onSuccess() {
    patchActive((b) => ({ done: b.done + 1 }));
    const batch = batchesRef.current.find((b) => b.id === activeIdRef.current);
    if (batch) {
      // Throttled so a big batch doesn't fire hundreds of refetches while SSE
      // already patches tiles live on the gallery page.
      const now = Date.now();
      if (now - lastInvalidateRef.current >= 2000) {
        lastInvalidateRef.current = now;
        queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", batch.galleryId] });
      }
    }
  }
  function onError(name: string, message: string) {
    patchActive((b) => ({ failed: b.failed + 1, failures: [...b.failures, { name, reason: message }] }));
  }
  function onComplete(result: { successful?: { id: string }[]; failed?: { id: string }[] }) {
    const id = activeIdRef.current;
    const batch = batchesRef.current.find((b) => b.id === id);
    patchActive({ status: "done", progressPct: 100 });
    for (const f of [...(result.successful ?? []), ...(result.failed ?? [])]) {
      try {
        uppy.removeFile(f.id);
      } catch {
        // already gone — fine
      }
    }
    if (batch) invalidateGallery(batch.galleryId);
    activeIdRef.current = null;
    maybeStartNext();
  }
  logicRef.current = { onProgress, onSuccess, onError, onComplete };

  // --- Queue processing ----------------------------------------------------
  function maybeStartNext() {
    if (activeIdRef.current) return;
    const next = batchesRef.current.find((b) => b.status === "queued");
    if (next) void startBatch(next.id);
  }

  async function startBatch(batchId: string) {
    activeIdRef.current = batchId; // claim synchronously so nothing else starts
    const batch = batchesRef.current.find((b) => b.id === batchId);
    const files = filesRef.current.get(batchId) ?? [];
    if (!batch || files.length === 0) {
      filesRef.current.delete(batchId);
      activeIdRef.current = null;
      maybeStartNext();
      return;
    }

    patchActive({ status: "checking" });

    // Dedup: skip files already in this gallery (matched by name + size).
    let toUpload = files;
    let skipped = 0;
    try {
      const { existing } = await api.post<{ existing: string[] }>(
        `/api/admin/galleries/${batch.galleryId}/uploads/check`,
        { files: files.map((f) => ({ filename: f.name, size: f.size ?? 0 })) },
      );
      const existingSet = new Set(existing);
      toUpload = files.filter((f) => !existingSet.has(`${f.name}:${f.size ?? 0}`));
      skipped = files.length - toUpload.length;
    } catch {
      // best-effort — the server checksum-dedupes regardless
    }
    filesRef.current.delete(batchId);

    if (toUpload.length === 0) {
      patchActive({ status: "done", total: 0, skipped, progressPct: 100 });
      activeIdRef.current = null;
      maybeStartNext();
      return;
    }

    const base = `/api/admin/galleries/${batch.galleryId}/uploads`;
    const endpoint = batch.setId ? `${base}?setId=${encodeURIComponent(batch.setId)}` : base;
    (uppy.getPlugin("XHRUpload") as { setOptions?: (o: { endpoint: string }) => void } | undefined)?.setOptions?.({
      endpoint,
    });

    patchActive({ status: "uploading", total: toUpload.length, skipped });
    try {
      uppy.addFiles(toUpload.map((f) => ({ name: f.name, type: f.type || "image/jpeg", data: f })));
    } catch {
      // addFiles still adds the valid files even if some are duplicates
    }
    void uppy.upload();
  }

  function enqueue(input: EnqueueInput) {
    const jpeg: File[] = [];
    let nonJpeg = 0;
    for (const f of input.files) {
      if (isJpeg(f.name ?? "")) jpeg.push(f);
      else nonJpeg += 1;
    }
    if (jpeg.length === 0 && nonJpeg === 0) return;

    const id = nextId();
    filesRef.current.set(id, jpeg);
    const batch: UploadBatch = {
      id,
      galleryId: input.galleryId,
      galleryTitle: input.galleryTitle,
      setId: input.setId,
      status: jpeg.length > 0 ? "queued" : "done",
      total: jpeg.length,
      done: 0,
      failed: 0,
      skipped: 0,
      nonJpeg,
      progressPct: 0,
      failures: [],
    };
    batchesRef.current = [...batchesRef.current, batch];
    commit();
    maybeStartNext();
  }

  function dismiss(batchId: string) {
    batchesRef.current = batchesRef.current.filter((b) => !(b.id === batchId && b.status === "done"));
    commit();
  }
  function clearFinished() {
    batchesRef.current = batchesRef.current.filter((b) => b.status !== "done");
    commit();
  }

  // Warn before a refresh / tab close / navigation would abort an in-flight
  // upload — works on any admin route since the manager is global.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const active = batchesRef.current.some(
        (b) => b.status === "queued" || b.status === "checking" || b.status === "uploading",
      );
      if (active) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const value: UploadManagerValue = {
    enqueue,
    dismiss,
    clearFinished,
    batches: batchesRef.current,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <UploadTray />
    </Ctx.Provider>
  );
}
