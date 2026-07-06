import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { api } from "../../../lib/api.ts";
import { lightboxSlide } from "../../../lib/slides.ts";
import {
  photoUrl,
  type GalleryDTO,
  type PhotoDTO,
  type PhotoListResponse,
  type SetsResponse,
} from "../../../lib/types.ts";

interface ProgressEvent {
  galleryId: string;
  photoId: string;
  status: "processing" | "ready" | "failed";
  width?: number;
  height?: number;
  thumbhash?: string;
}

type GridFilter = "all" | "favorites" | "failed";

const PAGE_SIZE = 200;
const UNKNOWN_PHOTO_INVALIDATE_THROTTLE_MS = 2000;
// After a photo reaches a terminal status, refresh the gallery *record* (which
// carries statusCounts) so the header's "N processing" / "N failed" numbers
// settle. Coalesced through a short trailing timer so a big batch triggers a
// handful of refetches, not one per photo — and crucially one final refetch
// ~this long after the last photo finishes, which is what actually clears the
// "N processing" indicator (the SSE tile-patching never touches that record).
const GALLERY_RECORD_REFRESH_DELAY_MS = 1500;

const SORT_OPTIONS = [
  { label: "Capture time — oldest first", by: "capturedAt", direction: "asc" },
  { label: "Capture time — newest first", by: "capturedAt", direction: "desc" },
  { label: "Filename — A to Z", by: "filename", direction: "asc" },
  { label: "Filename — Z to A", by: "filename", direction: "desc" },
] as const;

export function AdminPhotoGrid({
  galleryId,
  photoCount,
  favoriteCount,
  failedCount,
  coverPhotoId,
}: {
  galleryId: string;
  photoCount: number;
  favoriteCount: number;
  failedCount: number;
  coverPhotoId: string | null;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<GridFilter>("all");
  // null = all sets, "ungrouped" = photos in no set, otherwise a set id.
  const [activeSet, setActiveSet] = useState<string | null>(null);
  const queryKey = ["admin-gallery-photos", galleryId, filter, activeSet ?? "*"];
  const listPrefix = ["admin-gallery-photos", galleryId];
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const setsQuery = useQuery({
    queryKey: ["admin-sets", galleryId],
    queryFn: () => api.get<SetsResponse>(`/api/admin/galleries/${galleryId}/sets`),
    staleTime: 30_000,
  });
  const sets = setsQuery.data?.sets ?? [];
  const ungroupedCount = setsQuery.data?.ungroupedCount ?? 0;

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [coverJustSet, setCoverJustSet] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filter !== "all") params.set("filter", filter);
      if (activeSet) params.set("setId", activeSet);
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

    // Events for photos not in any cached page (uploaded moments ago, from
    // another tab, or excluded by the active filter) can't be patched in
    // place — fall back to one throttled refetch instead of dropping them.
    let lastUnknownInvalidateAt = 0;

    // Trailing-coalesced refresh of the gallery record so header counts settle.
    let galleryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleGalleryRecordRefresh = () => {
      if (galleryRefreshTimer) return;
      galleryRefreshTimer = setTimeout(() => {
        galleryRefreshTimer = null;
        queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
      }, GALLERY_RECORD_REFRESH_DELAY_MS);
    };

    source.onmessage = (event) => {
      const payload: ProgressEvent = JSON.parse(event.data);
      // A photo reaching ready/failed changes the gallery's statusCounts, which
      // drives the header — refresh that record (coalesced) whether or not the
      // tile itself is in a cached page.
      if (payload.status === "ready" || payload.status === "failed") {
        scheduleGalleryRecordRefresh();
      }
      // Patch every cached filter variant that contains the photo.
      const entries = queryClient.getQueriesData<InfiniteData<PhotoListResponse>>({
        queryKey: ["admin-gallery-photos", galleryId],
      });
      let known = false;
      for (const [key, data] of entries) {
        if (!data?.pages.some((page) => page.photos.some((p) => p.id === payload.photoId))) continue;
        known = true;
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
      }

      if (!known) {
        const now = Date.now();
        if (now - lastUnknownInvalidateAt >= UNKNOWN_PHOTO_INVALIDATE_THROTTLE_MS) {
          lastUnknownInvalidateAt = now;
          queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
        }
      }
    };

    return () => {
      if (galleryRefreshTimer) clearTimeout(galleryRefreshTimer);
      source.close();
    };
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
      queryClient.invalidateQueries({ queryKey: listPrefix });
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
      // Requeued photos leave the failed view on the next refetch.
      if (filter !== "all") {
        queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
      }
    },
  });

  const reorder = useMutation({
    mutationFn: (option: (typeof SORT_OPTIONS)[number]) =>
      api.post(`/api/admin/galleries/${galleryId}/reorder`, {
        by: option.by,
        direction: option.direction,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listPrefix });
    },
    onError: () => setActionError("Couldn't reorder the photos. Try again."),
  });

  const assignToSet = useMutation({
    mutationFn: (setId: string | null) =>
      api.post<{ assigned: number }>(`/api/admin/galleries/${galleryId}/photos/assign`, {
        photoIds: [...selected],
        setId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listPrefix });
      queryClient.invalidateQueries({ queryKey: ["admin-sets", galleryId] });
      exitSelectionMode();
    },
    onError: () => setActionError("Couldn't move the selected photos. Try again."),
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

  /** Selects every photo in the CURRENT view (respects the active filter + set
   * tab). Loads any not-yet-fetched pages first so "all" really means all. */
  async function selectAllInView() {
    setSelectingAll(true);
    setDeleteArmed(false);
    try {
      let hasMore = query.hasNextPage;
      while (hasMore) {
        const r = await query.fetchNextPage();
        hasMore = r.hasNextPage ?? false;
      }
      const data = queryClient.getQueryData<InfiniteData<PhotoListResponse>>(queryKey);
      setSelected(new Set(data?.pages.flatMap((page) => page.photos.map((p) => p.id)) ?? []));
    } finally {
      setSelectingAll(false);
    }
  }

  function clearSelection() {
    setDeleteArmed(false);
    setSelected(new Set());
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

  const showFailedPill = failedCount > 0 || filter === "failed";

  return (
    <>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        {selectionMode ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2">
              <span>
                {selected.size === 0
                  ? "Tap photos to select them."
                  : `${selected.size} ${selected.size === 1 ? "photo" : "photos"} selected`}
              </span>
              <span className="flex items-center gap-2 text-xs font-medium">
                <button
                  onClick={() => void selectAllInView()}
                  disabled={selectingAll}
                  className="text-text-1 underline underline-offset-2 transition-colors hover:text-text-2 disabled:opacity-50"
                >
                  {selectingAll ? "Selecting…" : "Select all"}
                </button>
                <button
                  onClick={clearSelection}
                  disabled={selected.size === 0}
                  className="text-text-2 underline underline-offset-2 transition-colors hover:text-text-1 disabled:opacity-40"
                >
                  Select none
                </button>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => coverCandidate && setCover.mutate(coverCandidate.id)}
                disabled={!coverCandidate || setCover.isPending}
                title={coverCandidate ? undefined : "Select exactly one processed photo"}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {coverJustSet ? "Cover set!" : "Set as cover"}
              </button>
              {sets.length > 0 && (
                <MoveToSetMenu
                  sets={sets}
                  disabled={selected.size === 0 || assignToSet.isPending}
                  pending={assignToSet.isPending}
                  onSelect={(setId) => assignToSet.mutate(setId)}
                />
              )}
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
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
              <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
                All {photoCount > 0 && <PillCount value={photoCount} />}
              </FilterPill>
              <FilterPill active={filter === "favorites"} onClick={() => setFilter("favorites")}>
                Favorites {favoriteCount > 0 && <PillCount value={favoriteCount} />}
              </FilterPill>
              {showFailedPill && (
                <FilterPill active={filter === "failed"} onClick={() => setFilter("failed")} danger>
                  Failed <PillCount value={failedCount} />
                </FilterPill>
              )}
            </div>
            <div className="flex items-center gap-2">
              <SortMenu disabled={reorder.isPending} onSelect={(option) => reorder.mutate(option)} />
              <button
                onClick={() => setSelectionMode(true)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2"
              >
                Select
              </button>
            </div>
          </>
        )}
      </div>
      {!selectionMode && sets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <FilterPill active={activeSet === null} onClick={() => setActiveSet(null)}>
            All sets
          </FilterPill>
          {sets.map((s) => (
            <FilterPill key={s.id} active={activeSet === s.id} onClick={() => setActiveSet(s.id)}>
              {s.title} <PillCount value={s.photoCount} />
              {!s.visibleToClient && <span className="text-text-3">· hidden</span>}
            </FilterPill>
          ))}
          {ungroupedCount > 0 && (
            <FilterPill active={activeSet === "ungrouped"} onClick={() => setActiveSet("ungrouped")}>
              Unsorted <PillCount value={ungroupedCount} />
            </FilterPill>
          )}
        </div>
      )}
      {actionError && <p className="mt-2 text-sm text-accent-500">{actionError}</p>}

      {query.isLoading && (
        <div className="flex justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
        </div>
      )}

      {query.isError && (
        <div className="mt-3 flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-line py-16 text-center">
          <p className="text-sm font-medium text-text-1">Couldn&apos;t load photos</p>
          <p className="text-sm text-text-3">Try reloading the page.</p>
        </div>
      )}

      {!query.isLoading && !query.isError && photos.length === 0 && (
        <div className="mt-3 flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-line py-16 text-center">
          <p className="text-sm font-medium text-text-1">
            {filter === "favorites"
              ? "No favorites yet"
              : filter === "failed"
                ? "No failed photos"
                : "No photos yet"}
          </p>
          <p className="text-sm text-text-3">
            {filter === "favorites"
              ? "Picks show up here once your client starts choosing."
              : filter === "failed"
                ? "Everything processed cleanly."
                : "Upload some above to get started."}
          </p>
        </div>
      )}

      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {photos.map((photo) => (
            <PhotoTile
              key={photo.id}
              photo={photo}
              isCover={photo.id === coverPhotoId}
              selectionMode={selectionMode}
              isSelected={selected.has(photo.id)}
              onClick={() => handleTileClick(photo)}
              onRetry={() => retryPhoto.mutate(photo.id)}
              retryPending={retryPhoto.isPending && retryPhoto.variables === photo.id}
            />
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-1" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          open
          close={() => setLightboxIndex(null)}
          index={lightboxIndex}
          plugins={[Zoom]}
          zoom={{ maxZoomPixelRatio: 3, doubleClickMaxStops: 2 }}
          on={{ view: ({ index }) => setLightboxIndex(index) }}
          slides={readyPhotos.map((p) => lightboxSlide(p))}
          render={{
            // Inside the portal — page-level fixed elements stack underneath
            // the slide layer and never receive clicks.
            controls: () => {
              const current = readyPhotos[lightboxIndex];
              if (!current) return null;
              const isCover = current.id === coverPhotoId;
              return (
                <button
                  type="button"
                  disabled={isCover || setCover.isPending}
                  onClick={() => setCover.mutate(current.id)}
                  className="tap-target on-dark absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-5 text-sm font-medium text-white ring-1 ring-white/15 backdrop-blur transition-transform active:scale-95 disabled:opacity-60"
                >
                  <CoverIcon />
                  {isCover ? "Current cover" : coverJustSet ? "Cover set!" : "Set as cover"}
                </button>
              );
            },
          }}
        />
      )}
    </>
  );
}

function CoverIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function FilterPill({
  active,
  danger,
  onClick,
  children,
}: {
  active: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-surface-3 font-medium text-text-1"
          : danger
            ? "text-accent-500 hover:text-accent-400"
            : "text-text-2 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

function PillCount({ value }: { value: number }) {
  return <span className="text-xs tabular-nums text-text-3">{value}</span>;
}

function SortMenu({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (option: (typeof SORT_OPTIONS)[number]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {disabled ? "Sorting…" : "Sort"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-xl border border-line-strong bg-surface-2 py-1 shadow-xl shadow-black/20"
        >
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect(option);
              }}
              className="block w-full px-4 py-2 text-left text-sm text-text-1 transition-colors hover:bg-surface-3"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoveToSetMenu({
  sets,
  disabled,
  pending,
  onSelect,
}: {
  sets: { id: string; title: string }[];
  disabled: boolean;
  pending: boolean;
  onSelect: (setId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Moving…" : "Move to…"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 max-h-64 w-52 overflow-y-auto rounded-xl border border-line-strong bg-surface-2 py-1 shadow-xl shadow-black/20"
        >
          {sets.map((s) => (
            <button
              key={s.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect(s.id);
              }}
              className="block w-full truncate px-4 py-2 text-left text-sm text-text-1 transition-colors hover:bg-surface-3"
            >
              {s.title}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSelect(null);
            }}
            className="block w-full px-4 py-2 text-left text-sm text-text-2 transition-colors hover:bg-surface-3"
          >
            Remove from set (Unsorted)
          </button>
        </div>
      )}
    </div>
  );
}

function PhotoTile({
  photo,
  isCover,
  selectionMode,
  isSelected,
  onClick,
  onRetry,
  retryPending,
}: {
  photo: PhotoDTO;
  isCover: boolean;
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
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
      className={`group relative aspect-square overflow-hidden rounded-lg bg-surface-2 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-text-1 ${
        clickable ? "cursor-pointer" : ""
      } ${isSelected ? "ring-2 ring-text-1 ring-offset-2 ring-offset-canvas" : ""}`}
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
        <div className="flex h-full w-full animate-pulse flex-col items-center justify-center gap-1 bg-surface-2 text-text-3">
          <div className="h-4 w-4 rounded-full border-2 border-line-strong border-t-text-2" />
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
              className="rounded-md bg-surface px-2 py-1 text-[10px] font-medium text-text-1 shadow-sm transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              {retryPending ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}

      {selectionMode && (
        <span
          className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
            isSelected
              ? "bg-text-1 text-invert shadow-sm"
              : "bg-black/25 text-transparent ring-1 ring-inset ring-white/70"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3 w-3">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}

      {photo.favorited && (
        <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface/90 text-accent-500 shadow-sm">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
            <path d="M12 21s-6.716-4.35-9.428-8.06C.29 9.94 1.02 6.2 4.2 5.02c2-.74 4.02.02 5.3 1.66C10.78 5.04 12.8 4.28 14.8 5.02c3.18 1.18 3.91 4.92 1.63 7.92C18.716 16.65 12 21 12 21z" />
          </svg>
        </span>
      )}

      {isCover && !selectionMode && (
        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white backdrop-blur">
          Cover
        </span>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {photo.originalFilename}
      </div>
    </div>
  );
}
