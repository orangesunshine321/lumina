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

  return (
    <div className="flex flex-col gap-8">
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
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink-900">{data.title}</h1>
      </div>

      <GallerySettingsPanel gallery={data} onUpdated={handleUpdated} onDeleted={handleDeleted} />

      <Section title="Upload photos">
        <UploadPanel galleryId={id} />
      </Section>

      <Section title={`Photos (${data.photoCount})`}>
        <AdminPhotoGrid galleryId={id} />
      </Section>

      <Section title="Lightroom export">
        <LightroomExportPanel galleryId={id} />
      </Section>

      <Section title="Download">
        <DownloadButtons galleryId={id} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">{title}</h2>
      {children}
    </section>
  );
}
