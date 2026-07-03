import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import { api } from "../../../lib/api.ts";
import type { SetsResponse } from "../../../lib/types.ts";

const INVALIDATE_THROTTLE_MS = 2000;

interface UploadFailure {
  name: string;
  reason: string;
}

interface BatchSummary {
  done: number;
  failed: number;
  skipped: number;
}

/** Maps the server's machine-readable upload errors to something the
 * photographer can actually act on. */
function uploadErrorMessage(xhr: XMLHttpRequest): string {
  if (xhr.status === 401) return "Your session expired — sign in again, then retry the upload.";
  let code: string | undefined;
  try {
    code = (JSON.parse(xhr.responseText) as { error?: string }).error;
  } catch {
    // non-JSON response body; fall through to the generic message
  }
  if (code === "invalid_file_type") return "Not a JPEG — export photos as JPEG and try again.";
  if (code === "file_too_large") return "File is too large (50MB max).";
  if (code === "image_too_large") return "Image resolution is too high — over 100 megapixels.";
  if (xhr.status >= 500) return "Server error — try again.";
  return `Upload failed (HTTP ${xhr.status}).`;
}

export function UploadPanel({ galleryId }: { galleryId: string }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Optional target set for this upload ("" = Unsorted). Shown only when the
  // gallery actually has sets.
  const setsQuery = useQuery({
    queryKey: ["admin-sets", galleryId],
    queryFn: () => api.get<SetsResponse>(`/api/admin/galleries/${galleryId}/sets`),
    staleTime: 30_000,
  });
  const sets = setsQuery.data?.sets ?? [];
  const [uploadSetId, setUploadSetId] = useState("");

  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const skippedRef = useRef(0);

  const [uppy] = useState(() => {
    const instance = new Uppy({
      // No Uppy allowedFileTypes restriction: it was rejecting valid camera
      // JPEGs (some arrive with an empty browser MIME type, and its
      // extension/MIME matching is finicky at scale). We filter to JPEGs by
      // filename in addFiles instead, and the server validates the real file
      // header on every upload — that's the authoritative check.
      // Uploads start explicitly after the dedup check below, so already-
      // uploaded files are removed before any bytes are sent.
      autoProceed: false,
    }).use(XHRUpload, {
      endpoint: `/api/admin/galleries/${galleryId}/uploads`,
      fieldName: "file",
      bundle: false,
      limit: 5,
      withCredentials: true,
      // 4xx responses are permanent (bad file, expired session) — retrying
      // them just delays the error message. Retry only network/5xx failures.
      shouldRetry: (xhr) => xhr.status === 0 || xhr.status >= 500,
      onAfterResponse: (xhr) => {
        if (xhr.status >= 200 && xhr.status < 300) return;
        throw new Error(uploadErrorMessage(xhr));
      },
    });

    instance.on("restriction-failed", (file, error) => {
      setFailures((prev) => [
        ...prev,
        { name: file?.name ?? "Unknown file", reason: error?.message ?? "File couldn't be added." },
      ]);
    });

    instance.on("files-added", async (files) => {
      if (!files.length) return;
      setSummary(null);
      try {
        const { existing } = await api.post<{ existing: string[] }>(
          `/api/admin/galleries/${galleryId}/uploads/check`,
          { files: files.map((f) => ({ filename: f.name, size: f.size ?? 0 })) },
        );
        // `existing` is a set of composite `filename:size` keys — match on the
        // same key, never on name alone, or a genuinely-new file that shares a
        // name with an existing photo (different size) would be wrongly skipped.
        const existingSet = new Set(existing);
        for (const file of files) {
          if (existingSet.has(`${file.name}:${file.size ?? 0}`)) {
            skippedRef.current += 1;
            instance.removeFile(file.id);
          }
        }
      } catch {
        // Dedup check is best-effort — the server checksum-dedupes anyway,
        // so never strand the batch because this pre-check failed.
      }
      const pending = instance.getFiles().length;
      setTotalCount(pending);
      if (pending > 0) {
        setUploading(true);
        instance.upload();
      } else if (skippedRef.current > 0) {
        // Everything in the drop was already uploaded.
        setSummary({ done: 0, failed: 0, skipped: skippedRef.current });
        skippedRef.current = 0;
      }
    });

    instance.on("progress", (pct) => setProgressPct(pct));
    instance.on("upload-success", () => {
      setDoneCount((prev) => prev + 1);
    });
    instance.on("upload-error", (file, error) => {
      setFailures((prev) => [
        ...prev,
        { name: file?.name ?? "Unknown file", reason: error.message },
      ]);
    });

    // Per-file invalidation is throttled: a 300-file batch would otherwise
    // trigger hundreds of full list refetches while SSE is already patching
    // tiles live. The `complete` handler below settles the final state.
    let lastInvalidatedAt = 0;
    instance.on("upload-success", () => {
      const now = Date.now();
      if (now - lastInvalidatedAt < INVALIDATE_THROTTLE_MS) return;
      lastInvalidatedAt = now;
      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
    });

    instance.on("complete", (result) => {
      // Clear the batch out of Uppy so the panel returns to idle and the same
      // files can be re-dropped later without fingerprint collisions.
      for (const file of [...(result?.successful ?? []), ...(result?.failed ?? [])]) {
        try {
          instance.removeFile(file.id);
        } catch {
          // already gone — fine
        }
      }
      setUploading(false);
      setProgressPct(0);
      setDoneCount(0);
      setTotalCount(0);
      setSummary({
        done: result?.successful?.length ?? 0,
        failed: result?.failed?.length ?? 0,
        skipped: skippedRef.current,
      });
      skippedRef.current = 0;

      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
      // photoCount lives on the gallery record — refresh the "Photos (N)"
      // heading and the gallery-list card counts.
      queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
      queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
    });

    return instance;
  });

  // Deliberately no `uppy.destroy()` cleanup: the instance is owned by this
  // component's state (created once via useState), and destroying it in a
  // cleanup breaks React StrictMode's dev double-mount. This mirrors the
  // documented @uppy/react pattern for useState-owned instances.

  // Point the upload endpoint at the chosen set (validated server-side). Files
  // added after this use the current endpoint, so uploads land in the right set.
  useEffect(() => {
    const base = `/api/admin/galleries/${galleryId}/uploads`;
    const endpoint = uploadSetId ? `${base}?setId=${encodeURIComponent(uploadSetId)}` : base;
    const plugin = uppy.getPlugin("XHRUpload") as { setOptions?: (o: { endpoint: string }) => void } | undefined;
    plugin?.setOptions?.({ endpoint });
  }, [uploadSetId, galleryId, uppy]);

  function addFiles(list: FileList | File[]) {
    setFailures([]);
    setSummary(null);
    // Filter to JPEGs ourselves by filename (case-insensitive) — reliable for
    // real camera exports, unlike Uppy's MIME/extension restriction which was
    // wrongly rejecting valid .jpg files. Non-JPEGs are reported as skipped;
    // the server re-validates the actual file header on upload.
    const skipped: string[] = [];
    const toAdd: Array<{ name: string; type: string; data: File }> = [];
    for (const file of Array.from(list)) {
      const name = file.name ?? "";
      if (!/\.jpe?g$/i.test(name)) {
        skipped.push(name || "unnamed file");
        continue;
      }
      toAdd.push({ name: file.name, type: file.type || "image/jpeg", data: file });
    }
    // One batched add for the whole selection — adding hundreds of files
    // one-by-one triggers a state update per file and is noticeably slow.
    if (toAdd.length > 0) {
      try {
        uppy.addFiles(toAdd);
      } catch {
        // addFiles still adds the valid files even if some are duplicates;
        // the server's checksum dedup is the authoritative guard regardless.
      }
    }
    if (skipped.length > 0) {
      setFailures(
        skipped.map((n) => ({
          name: n,
          reason: "Not a JPEG — only exported JPEGs can be uploaded.",
        })),
      );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {sets.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-text-2">
          Upload to
          <select
            value={uploadSetId}
            onChange={(e) => setUploadSetId(e.target.value)}
            disabled={uploading}
            className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-text-1 outline-none focus:border-line-strong disabled:opacity-50"
          >
            <option value="">Unsorted</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <span className="text-xs text-text-3">— or move photos into a set later from the grid.</span>
        </label>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-label="Add photos to upload"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors ${
          dragOver
            ? "border-text-2 bg-surface-2"
            : "border-line bg-surface hover:border-line-strong hover:bg-surface-2/50"
        }`}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
            <path
              d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <p className="text-sm font-medium text-text-1">
            Drag your exported JPEGs here <span className="text-text-3">—</span>{" "}
            <span className="underline decoration-line-strong underline-offset-2">or browse</span>
          </p>
          <p className="mt-1 text-xs text-text-3">
            JPEG only · up to 50MB each · re-dropping the same folder skips what's already uploaded
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,image/jpeg"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploading && (
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm font-medium text-text-1">
              Uploading {Math.min(doneCount + 1, totalCount)} of {totalCount}
            </span>
            <span className="text-xs tabular-nums text-text-3">{progressPct}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-text-1 transition-[width] duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-text-3">
            {doneCount} done
            {failures.length > 0 && (
              <>
                {" · "}
                <span className="text-accent-500">{failures.length} failed</span>
              </>
            )}{" "}
            · photos appear below as they finish processing
          </p>
        </div>
      )}

      {!uploading && summary && (
        <p className="text-sm text-text-2">
          {summary.done > 0 && (
            <>
              Uploaded {summary.done} {summary.done === 1 ? "photo" : "photos"}.
            </>
          )}
          {summary.skipped > 0 && (
            <> Skipped {summary.skipped} already in this gallery.</>
          )}
          {summary.done === 0 && summary.skipped === 0 && summary.failed === 0 && (
            <>Nothing to upload.</>
          )}
          {summary.failed > 0 && (
            <span className="text-accent-500">
              {" "}
              {summary.failed} {summary.failed === 1 ? "file" : "files"} failed — details below.
            </span>
          )}
        </p>
      )}

      {failures.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-xl border border-accent-500/30 bg-surface px-4 py-3 text-xs">
          {failures.map((failure, i) => (
            <li key={`${failure.name}-${i}`} className="flex gap-2 py-0.5">
              <span className="shrink-0 font-medium text-text-1">{failure.name}</span>
              <span className="text-accent-500">{failure.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
