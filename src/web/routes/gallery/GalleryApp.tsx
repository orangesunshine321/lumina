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

  const meta = useQuery({
    queryKey,
    queryFn: () => api.get<GalleryPublicDTO>(`/api/gallery/${slug}`),
    retry: false,
  });

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
      <header className="sticky top-0 z-10 border-b border-ink-100 bg-white/80 px-4 py-4 text-center backdrop-blur sm:px-6">
        <h1 className="text-base font-semibold tracking-tight text-ink-900">{gallery.title}</h1>
      </header>
      <PhotoGrid slug={slug} />
    </div>
  );
}
