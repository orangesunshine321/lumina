import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { GalleryDTO, SettingsResponse } from "../../lib/types.ts";
import { copyText } from "../../lib/clipboard.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { GallerySettingsPanel } from "./galleries/GallerySettingsPanel.tsx";
import { UploadPanel } from "./galleries/UploadPanel.tsx";
import { AdminPhotoGrid } from "./galleries/AdminPhotoGrid.tsx";
import { LightroomExportPanel } from "./galleries/LightroomExportPanel.tsx";
import { DownloadButtons } from "./galleries/DownloadButtons.tsx";
import { SetsPanel } from "./galleries/SetsPanel.tsx";

export function GalleryDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["admin-gallery", id];

  const gallery = useQuery({
    queryKey,
    queryFn: () => api.get<GalleryDTO>(`/api/admin/galleries/${id}`),
  });

  if (gallery.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
      </div>
    );
  }

  if (gallery.isError || !gallery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-sm text-text-3">Couldn&apos;t load this gallery.</p>
        <Link to="/admin" className="text-sm font-medium text-text-1 underline underline-offset-2">
          Back to galleries
        </Link>
      </div>
    );
  }

  const data = gallery.data;

  function handleUpdated(updated: GalleryDTO) {
    queryClient.setQueryData(queryKey, updated);
    queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
  }

  function handleDeleted() {
    queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
    navigate("/admin");
  }

  const inFlight = data.statusCounts.pending + data.statusCounts.processing;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Link
            to="/admin"
            className="tap-target -ml-2 flex items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
            aria-label="Back to galleries"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-medium tracking-tight text-text-1">
              {data.title}
            </h1>
            <p className="mt-0.5 text-xs text-text-3">
              {data.photoCount} {data.photoCount === 1 ? "photo" : "photos"}
              {data.favoriteCount > 0 && (
                <>
                  {" · "}
                  {data.favoriteCount} {data.favoriteCount === 1 ? "favorite" : "favorites"}
                </>
              )}
              {inFlight > 0 && <> · {inFlight} processing</>}
              {data.statusCounts.failed > 0 && (
                <span className="text-accent-500"> · {data.statusCounts.failed} failed</span>
              )}
              {data.originalsBytes > 0 && <> · {formatBytes(data.originalsBytes)}</>}
            </p>
          </div>
        </div>

        <ShareBar slug={data.slug} />
      </div>

      {inFlight > 0 && data.photoCount > 0 && (
        <ProcessingBar
          total={data.photoCount}
          processed={Math.max(0, data.photoCount - inFlight)}
          failed={data.statusCounts.failed}
        />
      )}

      {data.selectionSubmittedAt && (
        <SelectionBanner
          galleryId={id}
          submittedAt={data.selectionSubmittedAt}
          note={data.selectionNote}
          favoriteCount={data.favoriteCount}
          onReviewed={handleUpdated}
        />
      )}

      <Section title="Upload">
        <ErrorBoundary label="the upload panel">
          <UploadPanel galleryId={id} galleryTitle={data.title} />
        </ErrorBoundary>
      </Section>

      <Section title="Sets">
        <ErrorBoundary label="the sets panel">
          <SetsPanel galleryId={id} />
        </ErrorBoundary>
      </Section>

      <Section title="Photos">
        <ErrorBoundary label="the photo grid">
          <AdminPhotoGrid
            galleryId={id}
            photoCount={data.photoCount}
            favoriteCount={data.favoriteCount}
            failedCount={data.statusCounts.failed}
            coverPhotoId={data.coverPhotoId}
          />
        </ErrorBoundary>
      </Section>

      <Section title="Deliver">
        <ErrorBoundary label="the export panels">
          <div className="grid gap-4 lg:grid-cols-2">
            <LightroomExportPanel galleryId={id} />
            <DownloadButtons galleryId={id} />
          </div>
        </ErrorBoundary>
      </Section>

      <Section title="Settings">
        <ErrorBoundary label="the gallery settings">
          <GallerySettingsPanel gallery={data} onUpdated={handleUpdated} onDeleted={handleDeleted} />
        </ErrorBoundary>
      </Section>
    </div>
  );
}

/** The share link is the single most-used thing on this page — it lives here,
 * prominent and one click away, rather than buried in settings. */
function ShareBar({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  // Prefer the operator's configured public domain (Public access & domain), so
  // the link is shareable even when the admin is browsing on localhost/a tunnel
  // address. Cached under the same key the settings dialogs use.
  const settings = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.get<SettingsResponse>("/api/admin/settings"),
    staleTime: 5 * 60_000,
  });
  const base = settings.data?.settings.publicBaseUrl || window.location.origin;
  const shareLink = `${base}/g/${slug}`;

  async function handleCopy() {
    // Works over plain HTTP too (e.g. a LAN address before HTTPS is set up),
    // where navigator.clipboard is unavailable.
    if (await copyText(shareLink)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2 pl-3">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className="h-4 w-4 shrink-0 text-text-3"
        aria-hidden
      >
        <path
          d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <input
        readOnly
        value={shareLink}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Gallery share link"
        className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-text-2 outline-none"
      />
      <button
        onClick={handleCopy}
        className="shrink-0 rounded-lg bg-text-1 px-3 py-1.5 text-sm font-medium text-invert transition-opacity hover:opacity-90"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
      <a
        href={shareLink}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2"
      >
        Open
      </a>
    </div>
  );
}

/** Live processing progress, driven by the gallery's statusCounts (refreshed
 * off the SSE stream as photos finish). Shown only while work is in flight. */
function ProcessingBar({
  total,
  processed,
  failed,
}: {
  total: number;
  processed: number;
  failed: number;
}) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-text-1">
          Processing photos — {processed} of {total} done
          {failed > 0 && <span className="text-accent-500"> · {failed} failed</span>}
        </p>
        <span className="text-xs tabular-nums text-text-3">{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-text-1 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-text-3">
        You can keep working — photos appear in the grid below as they finish.
      </p>
    </div>
  );
}

function SelectionBanner({
  galleryId,
  submittedAt,
  note,
  favoriteCount,
  onReviewed,
}: {
  galleryId: string;
  submittedAt: string;
  note: string | null;
  favoriteCount: number;
  onReviewed: (gallery: GalleryDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function markReviewed() {
    setBusy(true);
    setError(false);
    try {
      const updated = await api.post<GalleryDTO>(`/api/admin/galleries/${galleryId}/selection/reviewed`);
      onReviewed(updated);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-text-1/15 bg-surface-2 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-1">
            Your client submitted their selection
          </p>
          <p className="mt-0.5 text-xs text-text-3">
            {favoriteCount} {favoriteCount === 1 ? "favorite" : "favorites"} ·{" "}
            {relativeTime(submittedAt)}. Copy the Lightroom list below to pull them in.
          </p>
        </div>
        <button
          onClick={() => void markReviewed()}
          disabled={busy}
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3 disabled:opacity-50"
        >
          {busy ? "…" : "Mark as reviewed"}
        </button>
      </div>
      {note && (
        <p className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-2">
          <span className="font-medium text-text-1">Note from client:</span> {note}
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-accent-500">Couldn&apos;t mark as reviewed — try again.</p>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">{title}</h2>
      {children}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
