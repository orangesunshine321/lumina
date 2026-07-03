import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import type { LightroomListResponse, SetsResponse } from "../../../lib/types.ts";

export function DownloadButtons(props: { galleryId: string }) {
  // Shares the ["lightroom-list", galleryId] cache key with LightroomExportPanel
  // so we know whether there's anything to download without a second endpoint.
  const list = useQuery({
    queryKey: ["lightroom-list", props.galleryId],
    queryFn: () =>
      api.get<LightroomListResponse>(`/api/admin/galleries/${props.galleryId}/lightroom-list`),
  });

  const setsQuery = useQuery({
    queryKey: ["admin-sets", props.galleryId],
    queryFn: () => api.get<SetsResponse>(`/api/admin/galleries/${props.galleryId}/sets`),
    staleTime: 30_000,
  });
  const sets = setsQuery.data?.sets ?? [];

  const hasFavorites = (list.data?.count ?? 0) > 0;

  function download(query: string) {
    window.location.href = `/api/admin/galleries/${props.galleryId}/download?${query}`;
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h3 className="text-sm font-semibold text-text-1">Download originals</h3>
      <p className="mt-0.5 text-xs text-text-3">
        Zips of the untouched files you uploaded, named exactly as they came out of Lightroom. You get every
        set regardless of what clients can download.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => download("scope=all")}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2"
        >
          {sets.length > 0 ? "Download everything" : "Download all"}
        </button>
        <button
          onClick={() => download("scope=favorites")}
          disabled={!hasFavorites}
          title={hasFavorites ? undefined : "No favorites yet"}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Download favorites
        </button>
      </div>
      {sets.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-2 text-xs font-medium text-text-3">By set</p>
          <div className="flex flex-wrap gap-2">
            {sets.map((s) => (
              <button
                key={s.id}
                onClick={() => download(`scope=set&setId=${s.id}`)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-text-1 transition-colors hover:bg-surface-2"
              >
                {s.title}
                <span className="ml-1.5 text-xs tabular-nums text-text-3">{s.photoCount}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
