import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../../lib/api.ts";
import type { GalleryDTO } from "../../../lib/types.ts";

export function GallerySettingsPanel(props: {
  gallery: GalleryDTO;
  onUpdated: (gallery: GalleryDTO) => void;
  onDeleted: () => void;
}) {
  const { gallery, onUpdated, onDeleted } = props;
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(gallery.title);
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Optimistic downloads toggle: flip immediately, fall back to the prop on error.
  const [optimisticDownloads, setOptimisticDownloads] = useState<boolean | null>(null);
  const [downloadsError, setDownloadsError] = useState<string | null>(null);
  const allowDownloads = optimisticDownloads ?? gallery.allowDownloads;

  const [linkArmed, setLinkArmed] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkDone, setLinkDone] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [reorderBusy, setReorderBusy] = useState<"capturedAt" | "filename" | null>(null);
  const [reorderDone, setReorderDone] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function saveTitle() {
    if (title.trim() === gallery.title) return;
    if (!title.trim()) {
      setTitleError("Title can't be empty.");
      setTitle(gallery.title);
      return;
    }
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await api.patch<GalleryDTO>(`/api/admin/galleries/${gallery.id}`, {
        title: title.trim(),
      });
      onUpdated(updated);
    } catch (err) {
      setTitleError(err instanceof ApiError ? err.message : "Couldn't save the title.");
      setTitle(gallery.title);
    } finally {
      setTitleSaving(false);
    }
  }

  async function setOrUpdatePassword() {
    if (!newPassword) return;
    setPasswordSaving(true);
    setPasswordError(null);
    try {
      const updated = await api.patch<GalleryDTO>(`/api/admin/galleries/${gallery.id}`, {
        password: newPassword,
      });
      onUpdated(updated);
      setNewPassword("");
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : "Couldn't update the password.");
    } finally {
      setPasswordSaving(false);
    }
  }

  async function removePassword() {
    if (!window.confirm("Remove the password from this gallery? Anyone with the link will be able to view it.")) {
      return;
    }
    setPasswordSaving(true);
    setPasswordError(null);
    try {
      const updated = await api.patch<GalleryDTO>(`/api/admin/galleries/${gallery.id}`, {
        password: null,
      });
      onUpdated(updated);
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : "Couldn't remove the password.");
    } finally {
      setPasswordSaving(false);
    }
  }

  async function toggleDownloads() {
    const next = !allowDownloads;
    setOptimisticDownloads(next);
    setDownloadsError(null);
    try {
      const updated = await api.patch<GalleryDTO>(`/api/admin/galleries/${gallery.id}`, {
        allowDownloads: next,
      });
      onUpdated(updated);
      setOptimisticDownloads(null);
    } catch {
      setOptimisticDownloads(null); // revert to server truth
      setDownloadsError("Couldn't change the download setting. Try again.");
    }
  }

  async function regenerateLink() {
    if (!linkArmed) {
      setLinkArmed(true);
      return;
    }
    setLinkBusy(true);
    setLinkError(null);
    try {
      const updated = await api.post<GalleryDTO>(`/api/admin/galleries/${gallery.id}/regenerate-slug`);
      onUpdated(updated);
      setLinkDone(true);
      setTimeout(() => setLinkDone(false), 2500);
    } catch {
      setLinkError("Couldn't create a new link. Try again.");
    } finally {
      setLinkBusy(false);
      setLinkArmed(false);
    }
  }

  async function reorder(by: "capturedAt" | "filename") {
    setReorderBusy(by);
    setReorderError(null);
    setReorderDone(false);
    try {
      await api.post(`/api/admin/galleries/${gallery.id}/reorder`, { by });
      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", gallery.id] });
      setReorderDone(true);
      setTimeout(() => setReorderDone(false), 2000);
    } catch {
      setReorderError("Couldn't reorder the photos. Try again.");
    } finally {
      setReorderBusy(null);
    }
  }

  async function handleDelete() {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/api/admin/galleries/${gallery.id}`);
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't delete this gallery.");
      setDeleting(false);
      setDeleteArmed(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h3 className="text-sm font-medium text-ink-900">Title</h3>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            className="w-full max-w-sm rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none focus:border-ink-900 focus:ring-2 focus:ring-ink-900/10"
          />
          {titleSaving && <span className="text-xs text-ink-400">Saving…</span>}
        </div>
        {titleError && <p className="mt-2 text-sm text-accent-500">{titleError}</p>}
      </section>

      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h3 className="text-sm font-medium text-ink-900">Password</h3>
        <p className="mt-1 text-xs text-ink-400">
          {gallery.hasPassword
            ? "This gallery currently requires a password to view."
            : "This gallery has no password — anyone with the link can view it."}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={gallery.hasPassword ? "New password" : "Set a password"}
            className="w-full max-w-sm rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none focus:border-ink-900 focus:ring-2 focus:ring-ink-900/10"
          />
          <button
            onClick={setOrUpdatePassword}
            disabled={passwordSaving || !newPassword}
            className="shrink-0 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
          >
            {gallery.hasPassword ? "Update" : "Set password"}
          </button>
        </div>
        {gallery.hasPassword && (
          <button
            onClick={removePassword}
            disabled={passwordSaving}
            className="mt-3 text-sm font-medium text-ink-600 underline decoration-ink-300 underline-offset-2 hover:text-ink-900 disabled:opacity-50"
          >
            Remove password
          </button>
        )}
        {passwordError && <p className="mt-2 text-sm text-accent-500">{passwordError}</p>}
      </section>

      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h3 className="text-sm font-medium text-ink-900">Sharing</h3>

        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-ink-700">Allow client downloads</p>
            <p className="mt-0.5 text-xs text-ink-400">
              Lets visitors download full-resolution originals — individually and as a zip.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={allowDownloads}
            aria-label="Allow client downloads"
            onClick={toggleDownloads}
            className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
              allowDownloads ? "bg-ink-900" : "bg-ink-200"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] ${
                allowDownloads ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        {downloadsError && <p className="mt-2 text-sm text-accent-500">{downloadsError}</p>}

        <div className="mt-5 border-t border-ink-100 pt-4">
          <p className="text-sm text-ink-700">Gallery link</p>
          <p className="mt-0.5 text-xs text-ink-400">
            If the link has spread further than you intended, issue a new one. The current link
            will stop working immediately.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={regenerateLink}
              disabled={linkBusy}
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
            >
              {linkBusy ? "Creating…" : linkArmed ? "Confirm — replace the link" : "Get a new link"}
            </button>
            {linkArmed && !linkBusy && (
              <button
                onClick={() => setLinkArmed(false)}
                className="text-sm font-medium text-ink-400 hover:text-ink-900"
              >
                Cancel
              </button>
            )}
            {linkDone && <span className="text-sm text-ink-600">New link created.</span>}
          </div>
          {linkError && <p className="mt-2 text-sm text-accent-500">{linkError}</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h3 className="text-sm font-medium text-ink-900">Photo order</h3>
        <p className="mt-1 text-xs text-ink-400">
          Photos are shown in upload (filename) order. Reorder by capture time if a multi-camera
          shoot interleaved wrongly.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => reorder("capturedAt")}
            disabled={reorderBusy !== null}
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
          >
            {reorderBusy === "capturedAt" ? "Reordering…" : "By capture time"}
          </button>
          <button
            onClick={() => reorder("filename")}
            disabled={reorderBusy !== null}
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
          >
            {reorderBusy === "filename" ? "Reordering…" : "By filename"}
          </button>
          {reorderDone && <span className="text-sm text-ink-600">Reordered.</span>}
        </div>
        {reorderError && <p className="mt-2 text-sm text-accent-500">{reorderError}</p>}
      </section>

      <section className="rounded-2xl border border-accent-500/20 bg-white p-5">
        <h3 className="text-sm font-medium text-ink-900">Delete gallery</h3>
        <p className="mt-1 text-xs text-ink-400">
          Permanently deletes this gallery, its photos, and all favorites. This can't be undone.
        </p>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="mt-3 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-400 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : deleteArmed ? "Confirm delete" : "Delete gallery"}
        </button>
        {deleteError && <p className="mt-2 text-sm text-accent-500">{deleteError}</p>}
      </section>
    </div>
  );
}
