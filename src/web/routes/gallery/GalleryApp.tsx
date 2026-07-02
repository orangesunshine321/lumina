import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";
import { photoUrl, type GalleryPublicDTO } from "../../lib/types.ts";
import { PasswordGate } from "./PasswordGate.tsx";
import { PhotoGrid } from "./PhotoGrid.tsx";

export function GalleryApp() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const queryKey = ["gallery-meta", slug];
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const gridStartRef = useRef<HTMLDivElement | null>(null);

  const meta = useQuery({
    queryKey,
    queryFn: () => api.get<GalleryPublicDTO>(`/api/gallery/${slug}`),
    retry: false,
  });

  const galleryTitle = meta.data?.title;
  useEffect(() => {
    if (galleryTitle) document.title = galleryTitle;
  }, [galleryTitle]);

  function switchView(next: boolean) {
    if (next === favoritesOnly) return;
    if (document.startViewTransition) {
      document.startViewTransition(() => setFavoritesOnly(next));
    } else {
      setFavoritesOnly(next);
    }
  }

  if (meta.isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
      </div>
    );
  }

  if (meta.isError) {
    const status = meta.error instanceof ApiError ? meta.error.status : 0;
    if (status === 404) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-2 px-6 text-center text-ink-400">
          <p className="font-display text-2xl text-ink-900">This link isn&apos;t valid</p>
          <p className="text-sm">Double-check the link your photographer sent you.</p>
        </div>
      );
    }
    return (
      <div className="flex h-screen w-screen items-center justify-center px-6 text-center text-ink-400">
        Something went wrong loading this gallery. Try reloading.
      </div>
    );
  }

  const gallery = meta.data;
  if (!gallery) return null;

  if (gallery.requiresPassword && !gallery.hasAccess) {
    return (
      <PasswordGate
        slug={slug}
        title={gallery.title}
        onUnlocked={() => queryClient.invalidateQueries({ queryKey })}
      />
    );
  }

  const scrollToGrid = () =>
    gridStartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="min-h-screen bg-ink-50">
      {gallery.coverPhotoId ? (
        <CoverHero gallery={gallery} onScrollHint={scrollToGrid} />
      ) : (
        <TypographicHeader gallery={gallery} />
      )}

      <div ref={gridStartRef} className="sticky top-0 z-10 border-b border-ink-100 bg-white/85 backdrop-blur">
        <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <span className="hidden min-w-0 flex-1 truncate text-sm font-medium text-ink-900 sm:block">
            {gallery.title}
          </span>

          {gallery.photoCount > 0 ? (
            <div
              className="inline-flex shrink-0 rounded-full bg-ink-100 p-0.5"
              role="group"
              aria-label="Photo filter"
            >
              <FilterPill active={!favoritesOnly} onClick={() => switchView(false)}>
                All photos
              </FilterPill>
              <FilterPill active={favoritesOnly} onClick={() => switchView(true)}>
                Favorites
                {gallery.favoriteCount > 0 && ` (${gallery.favoriteCount})`}
              </FilterPill>
            </div>
          ) : (
            <span />
          )}

          <div className="flex flex-1 justify-end sm:flex-none">
            {gallery.allowDownloads && gallery.photoCount > 0 && (
              <DownloadMenu slug={slug} favoriteCount={gallery.favoriteCount} />
            )}
          </div>
        </div>
      </div>

      <PhotoGrid slug={slug} favoritesOnly={favoritesOnly} allowDownloads={gallery.allowDownloads} />
    </div>
  );
}

/** The Pixieset signature: the shoot's cover photo, full-bleed, with the
 * gallery title set in display type over a soft scrim. */
function CoverHero({
  gallery,
  onScrollHint,
}: {
  gallery: GalleryPublicDTO;
  onScrollHint: () => void;
}) {
  return (
    <div className="relative h-[65vh] min-h-[420px] w-full overflow-hidden bg-ink-950">
      <img
        src={photoUrl(gallery.coverPhotoId!, "preview2x")}
        alt=""
        loading="eager"
        fetchPriority="high"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/70 via-ink-950/20 to-ink-950/10" />

      <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-4xl font-light tracking-wide text-white drop-shadow-sm sm:text-5xl md:text-6xl">
          {gallery.title}
        </h1>
        <MetaLine gallery={gallery} className="mt-4 text-sm text-white/85" heartClass="fill-white/85" />
      </div>

      <button
        type="button"
        onClick={onScrollHint}
        aria-label="View gallery"
        className="on-dark tap-target absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full text-white/80 transition-colors hover:text-white"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="hero-hint h-7 w-7">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** No cover photo yet — a calm, typographic opening instead of a broken hero. */
function TypographicHeader({ gallery }: { gallery: GalleryPublicDTO }) {
  return (
    <div className="flex flex-col items-center px-6 pb-12 pt-20 text-center sm:pb-16 sm:pt-28">
      <h1 className="font-display text-4xl font-light tracking-wide text-ink-900 sm:text-5xl">
        {gallery.title}
      </h1>
      <MetaLine gallery={gallery} className="mt-3 text-sm text-ink-400" heartClass="fill-accent-500" />
    </div>
  );
}

function MetaLine({
  gallery,
  className,
  heartClass,
}: {
  gallery: GalleryPublicDTO;
  className: string;
  heartClass: string;
}) {
  return (
    <p className={`flex items-center justify-center gap-1.5 ${className}`}>
      <span>
        {gallery.photoCount} {gallery.photoCount === 1 ? "photo" : "photos"}
      </span>
      {gallery.favoriteCount > 0 && (
        <>
          <span aria-hidden>·</span>
          <svg viewBox="0 0 24 24" className={`h-3 w-3 ${heartClass}`} aria-hidden>
            <path d="M12 21s-6.7-4.35-9.3-8.1C1 10.1 1.7 6.6 4.6 5.1c2.3-1.2 4.9-.4 6.4 1.5l1 1.3 1-1.3c1.5-1.9 4.1-2.7 6.4-1.5 2.9 1.5 3.6 5 1.9 7.8C18.7 16.65 12 21 12 21z" />
          </svg>
          <span>
            {gallery.favoriteCount} {gallery.favoriteCount === 1 ? "favorite" : "favorites"}
          </span>
        </>
      )}
    </p>
  );
}

function DownloadMenu({ slug, favoriteCount }: { slug: string; favoriteCount: number }) {
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

  function download(scope: "all" | "favorites") {
    setOpen(false);
    window.location.href = `/api/gallery/${slug}/download?scope=${scope}`;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="tap-target flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="hidden sm:inline">Download</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-ink-100 bg-white py-1 shadow-lg"
        >
          <button
            role="menuitem"
            onClick={() => download("all")}
            className="block w-full px-4 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-ink-50"
          >
            All photos
          </button>
          <button
            role="menuitem"
            disabled={favoriteCount === 0}
            onClick={() => download("favorites")}
            className="block w-full px-4 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Favorites{favoriteCount > 0 ? ` (${favoriteCount})` : ""}
          </button>
        </div>
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-9 rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-white text-ink-900 shadow-sm" : "text-ink-600 hover:text-ink-900"
      }`}
    >
      {children}
    </button>
  );
}
