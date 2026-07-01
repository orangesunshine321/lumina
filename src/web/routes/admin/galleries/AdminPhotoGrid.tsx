import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import { photoUrl, type PhotoDTO, type PhotoListResponse } from "../../../lib/types.ts";

interface ProgressEvent {
  galleryId: string;
  photoId: string;
  status: "processing" | "ready" | "failed";
  width?: number;
  height?: number;
  thumbhash?: string;
}

const PAGE_SIZE = 200;
const UNKNOWN_PHOTO_INVALIDATE_THROTTLE_MS = 2000;

export function AdminPhotoGrid({ galleryId }: { galleryId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin-gallery-photos", galleryId];
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) params.set("cursor", pageParam);
      return api.get<PhotoListResponse>(`/api/admin/galleries/${galleryId}/photos?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
          query.fetchNextPage();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  useEffect(() => {
    const source = new EventSource(`/api/admin/galleries/${galleryId}/photos/stream`, {
      withCredentials: true,
    });

    // Events for photos not yet in any cached page (uploaded moments ago, or
    // from another tab) can't be patched in place — fall back to one throttled
    // refetch instead of dropping them and leaving tiles stuck on "Queued…".
    let lastUnknownInvalidateAt = 0;

    source.onmessage = (event) => {
      const payload: ProgressEvent = JSON.parse(event.data);
      const key = ["admin-gallery-photos", galleryId];
      const data = queryClient.getQueryData<InfiniteData<PhotoListResponse>>(key);
      const known = data?.pages.some((page) => page.photos.some((p) => p.id === payload.photoId));

      if (!known) {
        const now = Date.now();
        if (now - lastUnknownInvalidateAt >= UNKNOWN_PHOTO_INVALIDATE_THROTTLE_MS) {
          lastUnknownInvalidateAt = now;
          queryClient.invalidateQueries({ queryKey: key });
        }
        return;
      }

      queryClient.setQueryData<InfiniteData<PhotoListResponse>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            photos: page.photos.map((photo) =>
              photo.id === payload.photoId
                ? {
                    ...photo,
                    status: payload.status,
                    width: payload.width ?? photo.width,
                    height: payload.height ?? photo.height,
                    thumbhash: payload.thumbhash ?? photo.thumbhash,
                  }
                : photo,
            ),
          })),
        };
      });
    };

    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryId]);

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-ink-200 py-16 text-center">
        <p className="text-sm font-medium text-ink-900">Couldn&apos;t load photos</p>
        <p className="text-sm text-ink-400">Try reloading the page.</p>
      </div>
    );
  }

  const photos = query.data?.pages.flatMap((page) => page.photos) ?? [];

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-ink-200 py-16 text-center">
        <p className="text-sm font-medium text-ink-900">No photos yet</p>
        <p className="text-sm text-ink-400">Upload some above to get started.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {photos.map((photo) => (
          <PhotoTile key={photo.id} photo={photo} />
        ))}
      </div>
      <div ref={sentinelRef} className="h-1" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
        </div>
      )}
    </>
  );
}

function PhotoTile({ photo }: { photo: PhotoDTO }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg bg-ink-100">
      {photo.status === "ready" && (
        <img
          src={photoUrl(photo.id, "thumb")}
          loading="lazy"
          decoding="async"
          alt={photo.originalFilename}
          className="h-full w-full object-cover"
        />
      )}

      {(photo.status === "pending" || photo.status === "processing") && (
        <div className="flex h-full w-full animate-pulse flex-col items-center justify-center gap-1 bg-ink-100 text-ink-400">
          <div className="h-4 w-4 rounded-full border-2 border-ink-300 border-t-ink-600" />
          <span className="text-[10px]">{photo.status === "processing" ? "Processing…" : "Queued…"}</span>
        </div>
      )}

      {photo.status === "failed" && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-accent-500/10 px-2 text-center text-accent-500">
          <span className="text-[10px] font-medium">Failed to process</span>
        </div>
      )}

      {photo.favorited && (
        <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-accent-500 shadow-sm">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
            <path d="M12 21s-6.716-4.35-9.428-8.06C.29 9.94 1.02 6.2 4.2 5.02c2-.74 4.02.02 5.3 1.66C10.78 5.04 12.8 4.28 14.8 5.02c3.18 1.18 3.91 4.92 1.63 7.92C18.716 16.65 12 21 12 21z" />
          </svg>
        </span>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-ink-950/70 to-transparent px-1.5 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {photo.originalFilename}
      </div>
    </div>
  );
}
