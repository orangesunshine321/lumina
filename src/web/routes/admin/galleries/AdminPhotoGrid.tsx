import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";
import { api } from "../../../lib/api.ts";
import { photoUrl, type GalleryDTO, type PhotoDTO, type PhotoListResponse } from "../../../lib/types.ts";

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

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [coverJustSet, setCoverJustSet] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

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

  const photos = query.data?.pages.flatMap((page) => page.photos) ?? [];
  const readyPhotos = photos.filter((p) => p.status === "ready");
  const selectedPhotos = photos.filter((p) => selected.has(p.id));
  const coverCandidate =
    selectedPhotos.length === 1 && selectedPhotos[0]?.status === "ready" ? selectedPhotos[0] : null;

  const deletePhotos = useMutation({
    mutationFn: (photoIds: string[]) =>
      api.post<{ deleted: number }>(`/api/admin/galleries/${galleryId}/photos/delete`, { photoIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
      queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
      queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
      queryClient.invalidateQueries({ queryKey: ["lightroom-list", galleryId] });
      exitSelectionMode();
    },
    onError: () => setActionError("Couldn't delete the selected photos. Try again."),
  });

  const setCover = useMutation({
    mutationFn: (photoId: string) =>
      api.patch<GalleryDTO>(`/api/admin/galleries/${galleryId}`, { coverPhotoId: photoId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
      queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
      setCoverJustSet(true);
      setTimeout(() => setCoverJustSet(false), 1500);
    },
    onError: () => setActionError("Couldn't set the cover photo. Try again."),
  });

  const retryPhoto = useMutation({
    mutationFn: (photoId: string) =>
      api.post<{ ok: boolean }>(`/api/admin/galleries/${galleryId}/photos/${photoId}/retry`),
    onSuccess: (_result, photoId) => {
      queryClient.setQueryData<InfiniteData<PhotoListResponse>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            photos: page.photos.map((photo) =>
              photo.id === photoId ? { ...photo, status: "pending" as const } : photo,
            ),
          })),
        };
      });
    },
  });

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelected(new Set());
    setDeleteArmed(false);
    setActionError(null);
  }

  function toggleSelected(photoId: string) {
    setDeleteArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function handleTileClick(photo: PhotoDTO) {
    if (selectionMode) {
      toggleSelected(photo.id);
      return;
    }
    if (photo.status === "ready") {
      setLightboxIndex(readyPhotos.findIndex((p) => p.id === photo.id));
    }
  }

  function handleDeleteClick() {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    deletePhotos.mutate([...selected]);
  }

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
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        {selectionMode ? (
          <>
            <span className="text-sm text-ink-600">
              {selected.size === 0
                ? "Tap photos to select them."
                : `${selected.size} ${selected.size === 1 ? "photo" : "photos"} selected`}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => coverCandidate && setCover.mutate(coverCandidate.id)}
                disabled={!coverCandidate || setCover.isPending}
                title={coverCandidate ? undefined : "Select exactly one processed photo"}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {coverJustSet ? "Cover set!" : "Set as cover"}
              </button>
              <button
                onClick={handleDeleteClick}
                disabled={selected.size === 0 || deletePhotos.isPending}
                className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-400 disabled:opacity-40"
              >
                {deletePhotos.isPending
                  ? "Deleting…"
                  : deleteArmed
                    ? `Delete ${selected.size} ${selected.size === 1 ? "photo" : "photos"}?`
                    : "Delete"}
              </button>
              <button
                onClick={exitSelectionMode}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <span />
            <button
              onClick={() => setSelectionMode(true)}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
            >
              Select
            </button>
          </>
        )}
      </div>
      {actionError && <p className="mt-2 text-sm text-accent-500">{actionError}</p>}

      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {photos.map((photo) => (
          <PhotoTile
            key={photo.id}
            photo={photo}
            selectionMode={selectionMode}
            isSelected={selected.has(photo.id)}
            onClick={() => handleTileClick(photo)}
            onRetry={() => retryPhoto.mutate(photo.id)}
            retryPending={retryPhoto.isPending && retryPhoto.variables === photo.id}
          />
        ))}
      </div>
      <div ref={sentinelRef} className="h-1" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          open
          close={() => setLightboxIndex(null)}
          index={lightboxIndex}
          on={{ view: ({ index }) => setLightboxIndex(index) }}
          slides={readyPhotos.map((p) => ({
            src: p.urls.preview,
            srcSet: [
              { src: p.urls.preview2x, width: (p.width ?? 800) * 2, height: (p.height ?? 600) * 2 },
            ],
          }))}
        />
      )}
    </>
  );
}

function PhotoTile({
  photo,
  selectionMode,
  isSelected,
  onClick,
  onRetry,
  retryPending,
}: {
  photo: PhotoDTO;
  selectionMode: boolean;
  isSelected: boolean;
  onClick: () => void;
  onRetry: () => void;
  retryPending: boolean;
}) {
  const clickable = selectionMode || photo.status === "ready";
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={
        selectionMode
          ? `${isSelected ? "Deselect" : "Select"} ${photo.originalFilename}`
          : photo.status === "ready"
            ? `View ${photo.originalFilename}`
            : undefined
      }
      aria-pressed={selectionMode ? isSelected : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={`group relative aspect-square overflow-hidden rounded-lg bg-ink-100 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ink-900 ${
        clickable ? "cursor-pointer" : ""
      } ${isSelected ? "ring-2 ring-ink-900 ring-offset-2" : ""}`}
    >
      {photo.status === "ready" && (
        <img
          src={photoUrl(photo.id, "thumb")}
          loading="lazy"
          decoding="async"
          alt={photo.originalFilename}
          className={`h-full w-full object-cover transition-opacity ${isSelected ? "opacity-80" : ""}`}
        />
      )}

      {(photo.status === "pending" || photo.status === "processing") && (
        <div className="flex h-full w-full animate-pulse flex-col items-center justify-center gap-1 bg-ink-100 text-ink-400">
          <div className="h-4 w-4 rounded-full border-2 border-ink-300 border-t-ink-600" />
          <span className="text-[10px]">{photo.status === "processing" ? "Processing…" : "Queued…"}</span>
        </div>
      )}

      {photo.status === "failed" && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-accent-500/10 px-2 text-center text-accent-500">
          <span className="text-[10px] font-medium">Failed to process</span>
          {!selectionMode && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              disabled={retryPending}
              className="rounded-md bg-white px-2 py-1 text-[10px] font-medium text-ink-700 shadow-sm transition-colors hover:bg-ink-50 disabled:opacity-50"
            >
              {retryPending ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}

      {selectionMode && (
        <span
          className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-sm transition-colors ${
            isSelected ? "bg-ink-900 text-white" : "bg-white/90 text-transparent"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3 w-3">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
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
