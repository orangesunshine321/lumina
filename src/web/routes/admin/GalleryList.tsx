import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";
import type { GalleryDTO } from "../../lib/types.ts";

export function GalleryList() {
  const [creating, setCreating] = useState(false);

  const galleries = useQuery({
    queryKey: ["admin-galleries"],
    queryFn: () => api.get<{ galleries: GalleryDTO[] }>("/api/admin/galleries"),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Galleries</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800"
        >
          New gallery
        </button>
      </div>

      {galleries.isLoading && (
        <div className="flex justify-center py-24">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
        </div>
      )}

      {galleries.isError && (
        <p className="py-24 text-center text-sm text-ink-400">
          Couldn&apos;t load galleries. Try reloading the page.
        </p>
      )}

      {galleries.data && galleries.data.galleries.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-200 py-24 text-center">
          <p className="text-base font-medium text-ink-900">No galleries yet</p>
          <p className="max-w-sm text-sm text-ink-400">
            Create a gallery, upload a batch of exported JPEGs, and share the link with your client.
          </p>
        </div>
      )}

      {galleries.data && galleries.data.galleries.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {galleries.data.galleries.map((gallery) => (
            <GalleryCard key={gallery.id} gallery={gallery} />
          ))}
        </div>
      )}

      {creating && <CreateGalleryDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function GalleryCard({ gallery }: { gallery: GalleryDTO }) {
  return (
    <Link
      to={`/admin/galleries/${gallery.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="relative flex aspect-4/3 items-center justify-center bg-gradient-to-br from-ink-100 to-ink-50">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-10 w-10 text-ink-200"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        {gallery.hasPassword && (
          <span className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink-600 shadow-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-4">
        <span className="truncate text-sm font-medium text-ink-900">{gallery.title}</span>
        <span className="text-xs text-ink-400">
          {gallery.photoCount} {gallery.photoCount === 1 ? "photo" : "photos"} ·{" "}
          {new Date(gallery.createdAt).toLocaleDateString()}
        </span>
      </div>
    </Link>
  );
}

function CreateGalleryDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink-900">New gallery</h2>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sarah — Spring shoot"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none focus:border-ink-900 focus:ring-2 focus:ring-ink-900/10"
          />
          {error && <p className="text-sm text-accent-500">{error}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createGallery.isPending}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800 disabled:opacity-50"
            >
              {createGallery.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
