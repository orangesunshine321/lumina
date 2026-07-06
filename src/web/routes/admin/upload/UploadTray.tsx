import { useState } from "react";
import { Link } from "react-router-dom";
import { useUploadManager, type UploadBatch } from "./UploadManager.tsx";

/**
 * The persistent, floating upload widget (bottom-right). Driven entirely by the
 * global UploadManager, so it stays put and keeps updating as you move between
 * admin pages. Hidden when there's nothing to show.
 */
export function UploadTray() {
  const { batches, dismiss, clearFinished } = useUploadManager();
  const [minimized, setMinimized] = useState(false);

  if (batches.length === 0) return null;

  const inFlight = batches.filter((b) => b.status !== "done");
  const allDone = inFlight.length === 0;
  const active = batches.find((b) => b.status === "uploading");
  const headline = allDone
    ? "Uploads complete"
    : active
      ? `Uploading ${active.done} of ${active.total}`
      : "Preparing upload…";

  return (
    <div className="fixed bottom-4 right-4 z-20 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-xl shadow-black/30">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-1">
          {allDone ? <CheckIcon /> : <Spinner />}
          <span className="truncate">{headline}</span>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {allDone && (
            <button
              onClick={clearFinished}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? "Expand uploads" : "Minimize uploads"}
            className="flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`h-3.5 w-3.5 transition-transform ${minimized ? "" : "rotate-180"}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      {!minimized && (
        <div className="max-h-72 divide-y divide-line overflow-y-auto">
          {batches.map((b) => (
            <BatchRow key={b.id} batch={b} onDismiss={() => dismiss(b.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BatchRow({ batch, onDismiss }: { batch: UploadBatch; onDismiss: () => void }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`/admin/galleries/${batch.galleryId}`}
          className="min-w-0 truncate text-sm font-medium text-text-1 hover:underline"
          title={batch.galleryTitle}
        >
          {batch.galleryTitle}
        </Link>
        {batch.status === "done" && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {batch.status === "uploading" && (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-text-1 transition-[width] duration-300 ease-out"
              style={{ width: `${batch.progressPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-text-3">
            {batch.done} of {batch.total} · {batch.progressPct}%
            {batch.failed > 0 && <span className="text-accent-500"> · {batch.failed} failed</span>}
          </p>
        </>
      )}

      {batch.status === "checking" && <p className="mt-1 text-xs text-text-3">Preparing…</p>}

      {batch.status === "queued" && (
        <p className="mt-1 text-xs text-text-3">
          Queued · {batch.total} {batch.total === 1 ? "photo" : "photos"}
        </p>
      )}

      {batch.status === "done" && (
        <p className="mt-1 text-xs text-text-3">
          {batch.done > 0 && <span className="font-medium text-positive-500">✓ {batch.done} uploaded</span>}
          {batch.skipped > 0 && <> · {batch.skipped} already there</>}
          {batch.failed > 0 && <span className="text-accent-500"> · {batch.failed} failed</span>}
          {batch.nonJpeg > 0 && <> · {batch.nonJpeg} not JPEG</>}
          {batch.done === 0 && batch.skipped === 0 && batch.failed === 0 && batch.nonJpeg === 0 && <>Nothing to upload</>}
        </p>
      )}

      {batch.status === "done" && batch.failures.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-accent-500">See failures</summary>
          <ul className="mt-1 max-h-24 overflow-y-auto text-[11px] text-text-3">
            {batch.failures.slice(0, 25).map((f, i) => (
              <li key={`${f.name}-${i}`} className="truncate py-0.5">
                <b className="text-text-2">{f.name}</b> — {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />;
}

function CheckIcon() {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-positive-500 text-white">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
