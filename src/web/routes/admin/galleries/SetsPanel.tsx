import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import type { SetDTO, SetsResponse } from "../../../lib/types.ts";

/**
 * Admin management of a gallery's photo sets. Sets are opt-in: a gallery with
 * none behaves exactly as before. Each set has two independent client-facing
 * toggles — visible-to-client and allow-downloads — so e.g. a "Raws" set can be
 * visible-but-not-downloadable, or hidden entirely.
 */
export function SetsPanel({ galleryId }: { galleryId: string }) {
  const queryClient = useQueryClient();
  const setsKey = ["admin-sets", galleryId];
  const [newTitle, setNewTitle] = useState("");

  const query = useQuery({
    queryKey: setsKey,
    queryFn: () => api.get<SetsResponse>(`/api/admin/galleries/${galleryId}/sets`),
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: setsKey });
    // Membership/visibility changes ripple into the photo grid + gallery record.
    queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", galleryId] });
    queryClient.invalidateQueries({ queryKey: ["admin-gallery", galleryId] });
  }

  const createSet = useMutation({
    mutationFn: (title: string) => api.post<SetDTO>(`/api/admin/galleries/${galleryId}/sets`, { title }),
    onSuccess: () => {
      setNewTitle("");
      invalidateAll();
    },
  });

  const updateSet = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<SetDTO, "title" | "visibleToClient" | "allowDownloads">> }) =>
      api.patch<SetDTO>(`/api/admin/galleries/${galleryId}/sets/${id}`, patch),
    onSuccess: () => invalidateAll(),
  });

  const deleteSet = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/admin/galleries/${galleryId}/sets/${id}`),
    onSuccess: () => invalidateAll(),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api.post(`/api/admin/galleries/${galleryId}/sets/reorder`, { orderedIds }),
    onSuccess: () => invalidateAll(),
  });

  const sets = query.data?.sets ?? [];
  const ungroupedCount = query.data?.ungroupedCount ?? 0;

  function move(index: number, dir: -1 | 1) {
    const next = [...sets];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next.map((s) => s.id));
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h3 className="text-sm font-semibold text-text-1">Sets</h3>
      <p className="mt-0.5 text-xs text-text-3">
        Group photos (e.g. <b>Raws</b> and <b>Final edits</b>). Toggle per set whether clients can see it and
        whether they can download it. Photos not in a set stay in <b>Unsorted</b>
        {ungroupedCount > 0 ? ` (${ungroupedCount})` : ""}.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {sets.map((set, i) => (
          <SetRow
            key={set.id}
            set={set}
            isFirst={i === 0}
            isLast={i === sets.length - 1}
            busy={updateSet.isPending || reorder.isPending || deleteSet.isPending}
            onRename={(title) => {
              if (title && title !== set.title) updateSet.mutate({ id: set.id, patch: { title } });
            }}
            onToggleVisible={(v) => updateSet.mutate({ id: set.id, patch: { visibleToClient: v } })}
            onToggleDownloads={(v) => updateSet.mutate({ id: set.id, patch: { allowDownloads: v } })}
            onMoveUp={() => move(i, -1)}
            onMoveDown={() => move(i, 1)}
            onDelete={() => {
              if (
                window.confirm(
                  `Delete the set “${set.title}”? Its ${set.photoCount} ${set.photoCount === 1 ? "photo" : "photos"} move to Unsorted — they are not deleted.`,
                )
              ) {
                deleteSet.mutate(set.id);
              }
            }}
          />
        ))}
        {sets.length === 0 && !query.isLoading && (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-text-3">
            No sets yet. Add one below, then move photos into it (select photos in the grid → “Move to set”),
            or upload straight into it.
          </p>
        )}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = newTitle.trim();
          if (t) createSet.mutate(t);
        }}
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New set name (e.g. Final edits)"
          maxLength={120}
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none focus:border-line-strong"
        />
        <button
          type="submit"
          disabled={!newTitle.trim() || createSet.isPending}
          className="shrink-0 rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {createSet.isPending ? "Adding…" : "Add set"}
        </button>
      </form>
      {(createSet.isError || updateSet.isError || deleteSet.isError || reorder.isError) && (
        <p className="mt-2 text-xs text-accent-500">Something went wrong. Try again.</p>
      )}
    </div>
  );
}

function SetRow({
  set,
  isFirst,
  isLast,
  busy,
  onRename,
  onToggleVisible,
  onToggleDownloads,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  set: SetDTO;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (title: string) => void;
  onToggleVisible: (v: boolean) => void;
  onToggleDownloads: (v: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(set.title);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-canvas px-3 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex flex-col">
          <button
            aria-label="Move up"
            disabled={isFirst || busy}
            onClick={onMoveUp}
            className="text-text-3 transition-colors hover:text-text-1 disabled:opacity-25"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3">
              <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            aria-label="Move down"
            disabled={isLast || busy}
            onClick={onMoveDown}
            className="text-text-3 transition-colors hover:text-text-1 disabled:opacity-25"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3">
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onRename(title.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          maxLength={120}
          aria-label="Set name"
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm font-medium text-text-1 outline-none focus:bg-surface-2"
        />
        <span className="shrink-0 text-xs tabular-nums text-text-3">
          {set.photoCount} {set.photoCount === 1 ? "photo" : "photos"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Toggle label="Visible" checked={set.visibleToClient} disabled={busy} onChange={onToggleVisible} />
        <Toggle
          label="Downloads"
          checked={set.allowDownloads}
          disabled={busy || !set.visibleToClient}
          hint={!set.visibleToClient ? "Make the set visible first" : undefined}
          onChange={onToggleDownloads}
        />
        <button
          aria-label={`Delete set ${set.title}`}
          disabled={busy}
          onClick={onDelete}
          className="tap-target flex items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-accent-500/10 hover:text-accent-500 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4">
            <path d="M4 7h16M9 7V4h6v3m-8 0l1 13h8l1-13" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      title={hint}
      className={`flex select-none items-center gap-1.5 text-xs font-medium ${disabled ? "text-text-3 opacity-60" : "text-text-2"}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? "bg-positive-500" : "bg-surface-3"
        } ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </button>
      {label}
    </label>
  );
}
