import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import type { SetsResponse } from "../../../lib/types.ts";
import { useUploadManager } from "../upload/UploadManager.tsx";

/**
 * Just the drop target + optional set picker. Handing files off to the global
 * UploadManager (see AdminApp) means the actual upload — and its progress in the
 * floating tray — survives navigating away from this gallery.
 */
export function UploadPanel({ galleryId, galleryTitle }: { galleryId: string; galleryTitle: string }) {
  const { enqueue } = useUploadManager();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Optional target set for this upload ("" = Unsorted). Shown only when the
  // gallery actually has sets. Captured per drop.
  const setsQuery = useQuery({
    queryKey: ["admin-sets", galleryId],
    queryFn: () => api.get<SetsResponse>(`/api/admin/galleries/${galleryId}/sets`),
    staleTime: 30_000,
  });
  const sets = setsQuery.data?.sets ?? [];
  const [uploadSetId, setUploadSetId] = useState("");

  const [dragOver, setDragOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function handleFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    enqueue({ galleryId, galleryTitle, setId: uploadSetId || null, files });
    const jpeg = files.filter((f) => /\.jpe?g$/i.test(f.name ?? "")).length;
    setNote(
      jpeg > 0
        ? `Added ${jpeg} ${jpeg === 1 ? "photo" : "photos"} to the upload — progress is in the tray, bottom-right.`
        : "No JPEGs in that selection — only exported JPEGs can be uploaded.",
    );
    setTimeout(() => setNote(null), 5000);
  }

  return (
    <div className="flex flex-col gap-3">
      {sets.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-text-2">
          Upload to
          <select
            value={uploadSetId}
            onChange={(e) => setUploadSetId(e.target.value)}
            className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-text-1 outline-none focus:border-line-strong"
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
          if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
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
            if (e.target.files?.length) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {note && <p className="text-sm text-text-2">{note}</p>}
      <p className="text-xs text-text-3">
        Uploads keep running while you work — you can leave this page and they'll continue in the tray.
      </p>
    </div>
  );
}
