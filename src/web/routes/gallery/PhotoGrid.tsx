import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RowsPhotoAlbum, type Photo, type RenderImageContext, type RenderExtras } from "react-photo-album";
import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";
import { thumbHashToDataURL } from "thumbhash";
import { api } from "../../lib/api.ts";
import type { FavoriteToggleResponse, PhotoDTO, PhotoListResponse } from "../../lib/types.ts";

interface AlbumPhoto extends Photo {
  id: string;
  favorited: boolean;
  thumbhash: string | null;
  urls: PhotoDTO["urls"];
}

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

export function PhotoGrid({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["gallery-photos", slug];
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "180" });
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
          urls: photo.urls,
        })),
      ),
    [query.data],
  );

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
    },
  });

  const renderImage = (
    props: React.ComponentPropsWithoutRef<"img">,
    context: RenderImageContext<AlbumPhoto>,
  ) => {
    const placeholder = context.photo.thumbhash ? decodeThumbhash(context.photo.thumbhash) : null;
    return (
      <div style={{ position: "relative", width: props.style?.width, height: props.style?.height }}>
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
          onLoad={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          style={{ ...props.style, position: "absolute", inset: 0, opacity: 0, transition: "opacity 300ms ease" }}
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
      className="tap-target absolute right-2 top-2 z-10 flex items-center justify-center rounded-full bg-ink-950/40 text-white backdrop-blur transition-transform active:scale-90"
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-ink-400">
        <p className="text-base font-medium text-ink-900">Couldn&apos;t load this gallery</p>
        <p className="max-w-sm text-sm">Check your connection and try reloading the page.</p>
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-ink-400">
        <p className="text-base font-medium text-ink-900">No photos yet</p>
        <p className="max-w-sm text-sm">Check back soon — your photographer is still uploading.</p>
      </div>
    );
  }

  return (
    <div className="px-2 pb-16 sm:px-4">
      <RowsPhotoAlbum<AlbumPhoto>
        photos={photos}
        targetRowHeight={220}
        spacing={4}
        onClick={({ index }) => openLightbox(index)}
        render={{ image: renderImage, extras: renderExtras }}
      />
      <div ref={sentinelRef} className="h-1" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
        </div>
      )}

      {lightboxIndex !== null && (
        <>
          <Lightbox
            open
            close={() => setLightboxIndex(null)}
            index={lightboxIndex}
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
            className="tap-target fixed bottom-8 left-1/2 z-[10000] flex -translate-x-1/2 items-center justify-center rounded-full bg-ink-950/60 px-5 text-white backdrop-blur transition-transform active:scale-90"
          >
            <HeartIcon filled={Boolean(photos[lightboxIndex]?.favorited)} />
            <span className="ml-2 text-sm font-medium">
              {photos[lightboxIndex]?.favorited ? "Favorited" : "Favorite"}
            </span>
          </button>
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
