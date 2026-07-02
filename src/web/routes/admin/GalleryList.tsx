import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";
import { photoUrl, type GalleryDTO, type PhotoListResponse } from "../../lib/types.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { SystemPanel } from "./SystemPanel.tsx";

export function GalleryList() {
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const debouncedSearch = useDebounced(search, 250);

  const galleries = useQuery({
    queryKey: ["admin-galleries", debouncedSearch, showArchived],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (showArchived) params.set("archived", "1");
      const qs = params.toString();
      return api.get<{ galleries: GalleryDTO[] }>(`/api/admin/galleries${qs ? `?${qs}` : ""}`);
    },
    placeholderData: (prev) => prev,
  });

  const isEmpty = galleries.data && galleries.data.galleries.length === 0;
  const isFiltering = Boolean(debouncedSearch) || showArchived;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-medium tracking-tight text-text-1">Galleries</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90"
        >
          New gallery
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search galleries…"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-text-1 outline-none transition-colors focus:border-line-strong"
          />
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-text-1"
          />
          Show archived
        </label>
      </div>

      <ErrorBoundary label="the gallery list">
        {galleries.isLoading && (
          <div className="flex justify-center py-24">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
          </div>
        )}

        {galleries.isError && (
          <p className="py-24 text-center text-sm text-text-3">
            Couldn&apos;t load galleries. Try reloading the page.
          </p>
        )}

        {isEmpty && isFiltering && (
          <p className="py-24 text-center text-sm text-text-3">
            No galleries match. Try a different search{showArchived ? "" : " or show archived galleries"}.
          </p>
        )}

        {isEmpty && !isFiltering && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-24 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-3">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-6 w-6"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </span>
            <p className="font-display text-lg font-medium text-text-1">Your first gallery awaits</p>
            <p className="max-w-sm text-sm text-text-3">
              Create a gallery, upload a batch of exported JPEGs, and share the link with your client.
            </p>
            <button
              onClick={() => setCreating(true)}
              className="mt-1 rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2"
            >
              Create a gallery
            </button>
          </div>
        )}

        {galleries.data && galleries.data.galleries.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {galleries.data.galleries.map((gallery) => (
              <GalleryCard key={gallery.id} gallery={gallery} />
            ))}
          </div>
        )}
      </ErrorBoundary>

      <SystemPanel />

      {creating && <CreateGalleryDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Warm the detail page's caches on hover/focus so clicking a card lands on
 * fully-rendered content instead of a spinner. Fire-and-forget. */
function prefetchGalleryDetail(queryClient: QueryClient, galleryId: string) {
  void queryClient.prefetchQuery({
    queryKey: ["admin-gallery", galleryId],
    queryFn: () => api.get<GalleryDTO>(`/api/admin/galleries/${galleryId}`),
  });
  void queryClient.prefetchInfiniteQuery({
    queryKey: ["admin-gallery-photos", galleryId, "all"],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "200" });
      if (pageParam) params.set("cursor", pageParam as string);
      return api.get<PhotoListResponse>(`/api/admin/galleries/${galleryId}/photos?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
  });
}

function GalleryCard({ gallery }: { gallery: GalleryDTO }) {
  const queryClient = useQueryClient();
  return (
    <Link
      to={`/admin/galleries/${gallery.id}`}
      onMouseEnter={() => prefetchGalleryDetail(queryClient, gallery.id)}
      onFocus={() => prefetchGalleryDetail(queryClient, gallery.id)}
      className={`group flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong ${
        gallery.archivedAt ? "opacity-60 hover:opacity-100" : ""
      }`}
    >
      <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden bg-surface-2">
        {gallery.coverPhotoId ? (
          <img
            src={photoUrl(gallery.coverPhotoId, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-10 w-10 text-text-3/50"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        )}
        {gallery.hasPassword && (
          <span className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </span>
        )}
        <div className="absolute left-3 top-3 flex gap-1.5">
          {gallery.archivedAt && (
            <span className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              Archived
            </span>
          )}
          {gallery.expiresAt && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm ${
                new Date(gallery.expiresAt) < new Date() ? "bg-accent-500/80" : "bg-black/55"
              }`}
            >
              {new Date(gallery.expiresAt) < new Date() ? "Expired" : "Expires"}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1 p-4">
        <span className="truncate text-sm font-medium text-text-1">{gallery.title}</span>
        <span className="flex items-center gap-1 text-xs text-text-3">
          {gallery.photoCount} {gallery.photoCount === 1 ? "photo" : "photos"} ·{" "}
          {new Date(gallery.createdAt).toLocaleDateString()}
          {gallery.favoriteCount > 0 && (
            <>
              {" · "}
              <span className="flex items-center gap-0.5 text-accent-500">
                {gallery.favoriteCount}
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-label="favorites">
                  <path d="M12 21s-6.716-4.35-9.428-8.06C.29 9.94 1.02 6.2 4.2 5.02c2-.74 4.02.02 5.3 1.66C10.78 5.04 12.8 4.28 14.8 5.02c3.18 1.18 3.91 4.92 1.63 7.92C18.716 16.65 12 21 12 21z" />
                </svg>
              </span>
            </>
          )}
        </span>
        {gallery.lastFavoriteAt && (
          <span className="text-xs text-text-3">Picks updated {relativeTime(gallery.lastFavoriteAt)}</span>
        )}
      </div>
    </Link>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function CreateGalleryDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const createGallery = useMutation({
    mutationFn: (title: string) => api.post<GalleryDTO>("/api/admin/galleries", { title }),
    onSuccess: (gallery) => {
      queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
      navigate(`/admin/galleries/${gallery.id}`);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Give the gallery a title.");
      return;
    }
    createGallery.mutate(title.trim());
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New gallery"
        className="w-full max-w-sm rounded-2xl border border-line-strong bg-surface-2 p-6 shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-text-1">New gallery</h2>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sarah — Spring shoot"
            className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none transition-colors placeholder:text-text-3 focus:border-line-strong"
          />
          {error && <p className="text-sm text-accent-500">{error}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-text-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createGallery.isPending}
              className="rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {createGallery.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
