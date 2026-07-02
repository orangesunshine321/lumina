import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { GalleryDTO } from "../../lib/types.ts";
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
      </div>
    );
  }

  if (gallery.isError || !gallery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-sm text-ink-400">Couldn&apos;t load this gallery.</p>
        <Link to="/admin" className="text-sm font-medium text-ink-900 underline">
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
  const photosHeading = (
    <>
      Photos ({data.photoCount}
      {data.favoriteCount > 0 && (
        <> · {data.favoriteCount} {data.favoriteCount === 1 ? "favorite" : "favorites"}</>
      )}
      {inFlight > 0 && <> · {inFlight} processing</>}
      {data.statusCounts.failed > 0 && (
        <span className="text-accent-500"> · {data.statusCounts.failed} failed</span>
      )}
      )
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Link
            to="/admin"
            className="tap-target flex items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-900"
            aria-label="Back to galleries"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight text-ink-900">
            {data.title}
          </h1>
        </div>

        <ShareBar slug={data.slug} />
      </div>

      <Section title="Upload photos">
        <UploadPanel galleryId={id} />
      </Section>

      <Section title={photosHeading}>
        <AdminPhotoGrid galleryId={id} />
      </Section>

      <Section title="Lightroom export">
        <LightroomExportPanel galleryId={id} />
      </Section>

      <Section title="Download">
        <DownloadButtons galleryId={id} />
      </Section>

      <Section title="Settings">
        <GallerySettingsPanel gallery={data} onUpdated={handleUpdated} onDeleted={handleDeleted} />
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
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink-100 bg-white p-3 shadow-sm">
      <input
        readOnly
        value={shareLink}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Gallery share link"
        className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-600"
      />
      <button
        onClick={handleCopy}
        className="shrink-0 rounded-lg bg-ink-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
      <a
        href={shareLink}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
      >
        Open
      </a>
    </div>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">{title}</h2>
      {children}
    </section>
  );
}
