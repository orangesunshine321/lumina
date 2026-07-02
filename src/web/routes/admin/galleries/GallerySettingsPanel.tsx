import { useState } from "react";
import { api, ApiError } from "../../../lib/api.ts";
import type { GalleryDTO } from "../../../lib/types.ts";

export function GallerySettingsPanel(props: {
  gallery: GalleryDTO;
  onUpdated: (gallery: GalleryDTO) => void;
  onDeleted: () => void;
}) {
  const { gallery, onUpdated, onDeleted } = props;

  const [title, setTitle] = useState(gallery.title);
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

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
            className="shrink-0 rounded-lg bg-ink-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800 disabled:opacity-50"
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
