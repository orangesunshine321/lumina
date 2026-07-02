import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";
import type { GalleryPublicDTO } from "../../lib/types.ts";
import { PasswordGate } from "./PasswordGate.tsx";
import { PhotoGrid } from "./PhotoGrid.tsx";

export function GalleryApp() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const queryKey = ["gallery-meta", slug];
  const [favoritesOnly, setFavoritesOnly] = useState(false);

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
          <p className="text-lg font-medium text-ink-900">This link isn&apos;t valid</p>
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

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="sticky top-0 z-10 border-b border-ink-100 bg-white/85 backdrop-blur">
        <div className="px-4 pb-2 pt-3 text-center sm:px-6">
          <h1 className="text-base font-semibold tracking-tight text-ink-900">{gallery.title}</h1>
          <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-ink-400">
            <span>
              {gallery.photoCount} {gallery.photoCount === 1 ? "photo" : "photos"}
            </span>
            {gallery.favoriteCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <svg viewBox="0 0 24 24" className="h-3 w-3 fill-accent-500" aria-hidden>
                  <path d="M12 21s-6.7-4.35-9.3-8.1C1 10.1 1.7 6.6 4.6 5.1c2.3-1.2 4.9-.4 6.4 1.5l1 1.3 1-1.3c1.5-1.9 4.1-2.7 6.4-1.5 2.9 1.5 3.6 5 1.9 7.8C18.7 16.65 12 21 12 21z" />
                </svg>
                <span>
                  {gallery.favoriteCount} {gallery.favoriteCount === 1 ? "favorite" : "favorites"}
                </span>
              </>
            )}
          </p>
        </div>

        {gallery.photoCount > 0 && (
          <div className="flex justify-center px-4 pb-2.5">
            <div className="inline-flex rounded-full bg-ink-100 p-0.5" role="group" aria-label="Photo filter">
              <FilterPill active={!favoritesOnly} onClick={() => switchView(false)}>
                All photos
              </FilterPill>
              <FilterPill active={favoritesOnly} onClick={() => switchView(true)}>
                Favorites
                {gallery.favoriteCount > 0 && ` (${gallery.favoriteCount})`}
              </FilterPill>
            </div>
          </div>
        )}
      </header>
      <PhotoGrid slug={slug} favoritesOnly={favoritesOnly} />
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
