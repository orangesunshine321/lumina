import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import Dashboard from "@uppy/react/dashboard";
import "@uppy/react/css/style.css";
import { api } from "../../../lib/api.ts";

const INVALIDATE_THROTTLE_MS = 2000;

/** Maps the server's machine-readable upload errors to something the
 * photographer can actually act on in the Dashboard's per-file error UI. */
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
  if (xhr.status >= 500) return "Server error — try again.";
  return `Upload failed (HTTP ${xhr.status}).`;
}

export function UploadPanel({ galleryId }: { galleryId: string }) {
  const queryClient = useQueryClient();

  const [uppy] = useState(() => {
    const instance = new Uppy({
      restrictions: { allowedFileTypes: [".jpg", ".jpeg", "image/jpeg"] },
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

    instance.on("files-added", async (files) => {
      if (!files.length) return;
      try {
        const { existing } = await api.post<{ existing: string[] }>(
          `/api/admin/galleries/${galleryId}/uploads/check`,
          { files: files.map((f) => ({ filename: f.name, size: f.size ?? 0 })) },
        );
        const existingSet = new Set(existing);
        for (const file of files) {
          if (existingSet.has(file.name)) {
            instance.removeFile(file.id);
          }
        }
      } catch {
        // Dedup check is best-effort — the server checksum-dedupes anyway,
        // so never strand the batch because this pre-check failed.
      }
      instance.upload();
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

    instance.on("complete", () => {
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
  // cleanup breaks React StrictMode's dev double-mount — the second mount
  // would render a Dashboard bound to a dead instance. This mirrors the
  // documented @uppy/react pattern for useState-owned instances.

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm">
      <Dashboard uppy={uppy} proudlyDisplayPoweredByUppy={false} height={320} />
    </div>
  );
}
