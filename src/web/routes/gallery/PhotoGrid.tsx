import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RowsPhotoAlbum, type Photo, type RenderImageContext, type RenderExtras } from "react-photo-album";
// The album's layout lives in this stylesheet — without it every photo
// wrapper computes to 0x0 and the grid renders invisibly.
import "react-photo-album/rows.css";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Captions from "yet-another-react-lightbox/plugins/captions";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import "yet-another-react-lightbox/plugins/captions.css";
import { thumbHashToDataURL } from "thumbhash";
import { api } from "../../lib/api.ts";
import type { FavoriteToggleResponse, PhotoDTO, PhotoListResponse } from "../../lib/types.ts";

interface AlbumPhoto extends Photo {
  id: string;
  favorited: boolean;
  thumbhash: string | null;
  baseFilename: string;
  urls: PhotoDTO["urls"];
}

const LIGHTBOX_PLUGINS = [Zoom, Counter, Captions];

// Decoding is ~1ms of base64 + PNG-encode work per placeholder, and this runs
// inside render for every visible photo — memoize so a favorite toggle (which
// re-renders the whole album) doesn't redo thousands of decodes on a phone.
const thumbhashCache = new Map<string, string | null>();

function decodeThumbhash(base64: string): string | null {
  const cached = thumbhashCache.get(base64);
  if (cached !== undefined) return cached;
  let dataUrl: string | null;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    dataUrl = thumbHashToDataURL(bytes);
  } catch {
    dataUrl = null;
  }
  thumbhashCache.set(base64, dataUrl);
  return dataUrl;
}

export function PhotoGrid({
  slug,
  favoritesOnly,
  allowDownloads,
}: {
  slug: string;
  favoritesOnly: boolean;
  allowDownloads: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["gallery-photos", slug, favoritesOnly ? "favorites" : "all"];
  const inactiveKey = ["gallery-photos", slug, favoritesOnly ? "all" : "favorites"];
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // The ids that get the first-load entrance animation — captured exactly
  // once, so pagination appends and favorite-toggle re-renders never replay it.
  const staggerIdsRef = useRef<Set<string> | null>(null);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "180" });
      if (favoritesOnly) params.set("favorites", "1");
      if (pageParam) params.set("cursor", pageParam);
      return api.get<PhotoListResponse>(`/api/gallery/${slug}/photos?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const photos = useMemo<AlbumPhoto[]>(
    () =>
      (query.data?.pages ?? []).flatMap((page) =>
        page.photos.map((photo) => ({
          key: photo.id,
          id: photo.id,
          src: photo.urls.thumb,
          width: photo.width ?? 800,
          height: photo.height ?? 600,
          favorited: Boolean(photo.favorited),
          thumbhash: photo.thumbhash,
          baseFilename: photo.baseFilename,
          urls: photo.urls,
        })),
      ),
    [query.data],
  );

  if (staggerIdsRef.current === null && photos.length > 0) {
    staggerIdsRef.current = new Set(photos.slice(0, 24).map((p) => p.id));
  }

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
          query.fetchNextPage();
        }
      },
      { rootMargin: "800px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  // In the favorites view, unfavoriting refetches and the photo list shrinks —
  // never leave the lightbox pointing past the end.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) {
      setLightboxIndex(photos.length > 0 ? photos.length - 1 : null);
    }
  }, [photos.length, lightboxIndex]);

  const toggleFavorite = useMutation({
    mutationFn: (photoId: string) =>
      api.post<FavoriteToggleResponse>(`/api/gallery/${slug}/photos/${photoId}/favorite`),
    onMutate: async (photoId: string) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ pages: PhotoListResponse[] }>(queryKey);
      queryClient.setQueryData<{ pages: PhotoListResponse[]; pageParams: unknown[] }>(queryKey, (old) => {
        if (!old) return old as any;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            photos: page.photos.map((p) => (p.id === photoId ? { ...p, favorited: !p.favorited } : p)),
          })),
        };
      });
      return { previous };
    },
    onError: (_err, _photoId, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (result, photoId) => {
      queryClient.setQueryData<{ pages: PhotoListResponse[]; pageParams: unknown[] }>(queryKey, (old) => {
        if (!old) return old as any;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            photos: page.photos.map((p) => (p.id === photoId ? { ...p, favorited: result.favorited } : p)),
          })),
        };
      });
      // Header/pill counts live in gallery-meta; the other view's cached list
      // is stale now too. When we're IN the favorites view, refetch it so an
      // unfavorited photo actually leaves the grid.
      queryClient.invalidateQueries({ queryKey: ["gallery-meta", slug] });
      queryClient.invalidateQueries({ queryKey: inactiveKey });
      if (favoritesOnly) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const renderImage = (
    props: React.ComponentPropsWithoutRef<"img">,
    context: RenderImageContext<AlbumPhoto>,
  ) => {
    const placeholder = context.photo.thumbhash ? decodeThumbhash(context.photo.thumbhash) : null;
    // Above-the-fold images shouldn't wait for the lazy loader — the first
    // rows are what "fast" feels like on a fresh open.
    const eager = context.index < 8;
    const staggered = staggerIdsRef.current?.has(context.photo.id) ?? false;
    // react-photo-album's render.image receives NO layout styles — its own
    // wrapper handles width, so the tile must derive its height from the
    // photo's aspect ratio. (Reading props.style here collapses every tile
    // to zero height: the blank-gallery bug.)
    const aspectPercent = (context.height / context.width) * 100;
    return (
      <div
        className={staggered ? "pg-tile pg-enter" : "pg-tile"}
        style={{
          position: "relative",
          width: "100%",
          paddingBottom: `${aspectPercent}%`,
          overflow: "hidden",
          ...(staggered ? { animationDelay: `${Math.min(context.index * 25, 300)}ms` } : {}),
        }}
      >
        {placeholder && (
          <img
            src={placeholder}
            alt=""
            aria-hidden
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
        <img
          {...props}
          className="pg-photo"
          loading={eager ? "eager" : props.loading}
          fetchPriority={eager ? "high" : undefined}
          ref={(img) => {
            // Cached images can complete before the load handler ever fires.
            if (img?.complete) img.style.opacity = "1";
          }}
          onLoad={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0,
            transition: "opacity 400ms ease-out, transform 400ms ease",
          }}
        />
      </div>
    );
  };

  const renderExtras: RenderExtras<AlbumPhoto> = (_props, context) => (
    <button
      type="button"
      aria-label={context.photo.favorited ? "Remove favorite" : "Add favorite"}
      onClick={(e) => {
        e.stopPropagation();
        toggleFavorite.mutate(context.photo.id);
      }}
      className="tap-target on-dark absolute right-2 top-2 z-10 flex items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-transform active:scale-90"
    >
      <HeartIcon filled={context.photo.favorited} />
    </button>
  );

  const openLightbox = (index: number) => {
    if (document.startViewTransition) {
      document.startViewTransition(() => setLightboxIndex(index));
    } else {
      setLightboxIndex(index);
    }
  };

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-text-1" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-text-2">
        <p className="text-base font-medium text-text-1">Couldn&apos;t load this gallery</p>
        <p className="max-w-sm text-sm">Check your connection and try reloading the page.</p>
      </div>
    );
  }

  if (photos.length === 0) {
    if (favoritesOnly) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-text-2">
          <svg viewBox="0 0 24 24" className="h-8 w-8 fill-none stroke-line-strong" strokeWidth="1.5" aria-hidden>
            <path d="M12 21s-6.7-4.35-9.3-8.1C1 10.1 1.7 6.6 4.6 5.1c2.3-1.2 4.9-.4 6.4 1.5l1 1.3 1-1.3c1.5-1.9 4.1-2.7 6.4-1.5 2.9 1.5 3.6 5 1.9 7.8C18.7 16.65 12 21 12 21z" />
          </svg>
          <p className="text-base font-medium text-text-1">No favorites yet</p>
          <p className="max-w-sm text-sm">Tap the heart on the photos you love and they&apos;ll collect here.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-text-2">
        <p className="text-base font-medium text-text-1">No photos yet</p>
        <p className="max-w-sm text-sm">Check back soon — your photographer is still uploading.</p>
      </div>
    );
  }

  return (
    <div className="px-2 pb-16 pt-1.5 sm:px-4">
      <RowsPhotoAlbum<AlbumPhoto>
        photos={photos}
        targetRowHeight={260}
        spacing={6}
        onClick={({ index }) => openLightbox(index)}
        render={{ image: renderImage, extras: renderExtras }}
      />
      <div ref={sentinelRef} className="h-1" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-text-1" />
        </div>
      )}

      {lightboxIndex !== null && (
        <>
          <Lightbox
            open
            close={() => setLightboxIndex(null)}
            index={lightboxIndex}
            plugins={LIGHTBOX_PLUGINS}
            zoom={{ maxZoomPixelRatio: 3, doubleClickMaxStops: 2 }}
            controller={{ closeOnBackdropClick: true }}
            styles={{
              captionsTitleContainer: { background: "transparent" },
              captionsTitle: {
                fontSize: "13px",
                fontWeight: 400,
                color: "rgba(255, 255, 255, 0.75)",
                textAlign: "center",
                paddingLeft: "72px",
                paddingRight: "72px",
              },
            }}
            on={{
              view: ({ index }) => {
                setLightboxIndex(index);
                // Slides only exist for pages loaded so far — keep fetching as
                // the client swipes toward the end so the lightbox never hits
                // a wall at a 180-photo page boundary.
                if (index >= photos.length - 5 && query.hasNextPage && !query.isFetchingNextPage) {
                  query.fetchNextPage();
                }
              },
            }}
            slides={photos.map((p) => ({
              src: p.urls.preview,
              title: p.baseFilename,
              srcSet: [{ src: p.urls.preview2x, width: (p.width ?? 800) * 2, height: (p.height ?? 600) * 2 }],
            }))}
          />
          <button
            type="button"
            aria-label={photos[lightboxIndex]?.favorited ? "Remove favorite" : "Add favorite"}
            onClick={() => {
              const id = photos[lightboxIndex]?.id;
              if (id) toggleFavorite.mutate(id);
            }}
            className="tap-target on-dark fixed bottom-8 left-1/2 z-[10000] flex -translate-x-1/2 items-center justify-center rounded-full bg-black/55 px-5 text-white ring-1 ring-white/15 backdrop-blur transition-transform active:scale-90"
          >
            <HeartIcon filled={Boolean(photos[lightboxIndex]?.favorited)} />
            <span className="ml-2 text-sm font-medium">
              {photos[lightboxIndex]?.favorited ? "Favorited" : "Favorite"}
            </span>
          </button>
          {allowDownloads && photos[lightboxIndex] && (
            <a
              href={`${photos[lightboxIndex]!.urls.original}?download=1`}
              download
              aria-label="Download this photo"
              className="tap-target on-dark fixed bottom-8 right-4 z-[10000] flex items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur transition-transform active:scale-90"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          )}
        </>
      )}
    </div>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill={filled ? "#e0475c" : "none"}
      stroke={filled ? "#e0475c" : "currentColor"}
      strokeWidth="2"
    >
      <path d="M12 21s-6.7-4.35-9.3-8.1C1 10.1 1.7 6.6 4.6 5.1c2.3-1.2 4.9-.4 6.4 1.5l1 1.3 1-1.3c1.5-1.9 4.1-2.7 6.4-1.5 2.9 1.5 3.6 5 1.9 7.8C18.7 16.65 12 21 12 21z" />
    </svg>
  );
}
