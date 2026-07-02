import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { GalleryDTO } from "../../lib/types.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { GallerySettingsPanel } from "./galleries/GallerySettingsPanel.tsx";
import { UploadPanel } from "./galleries/UploadPanel.tsx";
import { AdminPhotoGrid } from "./galleries/AdminPhotoGrid.tsx";
import { LightroomExportPanel } from "./galleries/LightroomExportPanel.tsx";
import { DownloadButtons } from "./galleries/DownloadButtons.tsx";

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
            </p>
          </div>
        </div>

        <ShareBar slug={data.slug} />
      </div>

      <Section title="Upload">
        <ErrorBoundary label="the upload panel">
          <UploadPanel galleryId={id} />
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
  const shareLink = `${window.location.origin}/g/${slug}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">{title}</h2>
      {children}
    </section>
  );
}
