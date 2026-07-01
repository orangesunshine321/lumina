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
    <div className="flex flex-wrap gap-3">
      <button
        onClick={() => download("all")}
        className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
      >
        Download all
      </button>
      <button
        onClick={() => download("favorites")}
        disabled={!hasFavorites}
        title={hasFavorites ? undefined : "No favorites yet"}
        className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Download favorites
      </button>
    </div>
  );
}
