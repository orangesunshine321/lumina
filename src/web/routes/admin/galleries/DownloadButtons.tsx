import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import type { LightroomListResponse } from "../../../lib/types.ts";

export function DownloadButtons(props: { galleryId: string }) {
  // Shares the ["lightroom-list", galleryId] cache key with LightroomExportPanel
  // so we know whether there's anything to download without a second endpoint.
  const list = useQuery({
    queryKey: ["lightroom-list", props.galleryId],
    queryFn: () =>
      api.get<LightroomListResponse>(`/api/admin/galleries/${props.galleryId}/lightroom-list`),
  });

  const hasFavorites = (list.data?.count ?? 0) > 0;

  function download(scope: "all" | "favorites") {
    window.location.href = `/api/admin/galleries/${props.galleryId}/download?scope=${scope}`;
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h3 className="text-sm font-semibold text-text-1">Download originals</h3>
      <p className="mt-0.5 text-xs text-text-3">
        Zips of the untouched files you uploaded, named exactly as they came out of Lightroom.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => download("all")}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2"
        >
          Download all
        </button>
        <button
          onClick={() => download("favorites")}
          disabled={!hasFavorites}
          title={hasFavorites ? undefined : "No favorites yet"}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Download favorites
        </button>
      </div>
    </div>
  );
}
