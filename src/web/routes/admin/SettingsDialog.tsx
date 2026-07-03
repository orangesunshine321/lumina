import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { AppSettings, SettingsResponse } from "../../lib/types.ts";
import { ProcessingSettingsFields } from "./ProcessingSettingsFields.tsx";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const query = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.get<SettingsResponse>("/api/admin/settings"),
  });
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = draft ?? query.data?.settings ?? null;

  async function save() {
    if (!value) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.patch<SettingsResponse>("/api/admin/settings", value);
      setDraft(res.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch {
      setError("Couldn't save settings. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="App settings"
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface-2 p-6 shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-1">Processing &amp; uploads</h2>
            <p className="mt-0.5 text-sm text-text-3">Applies to new uploads — no restart needed.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="tap-target -mr-2 -mt-2 flex items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-6">
          {query.isLoading && <p className="text-sm text-text-3">Loading…</p>}
          {query.isError && <p className="text-sm text-accent-500">Couldn&apos;t load settings.</p>}
          {value && query.data && (
            <>
              <ProcessingSettingsFields value={value} limits={query.data.limits} onChange={setDraft} />
              {error && <p className="mt-4 text-sm text-accent-500">{error}</p>}
              <button
                onClick={() => void save()}
                disabled={saving}
                className="mt-6 w-full rounded-lg bg-text-1 px-4 py-2.5 text-sm font-medium text-invert transition-opacity hover:opacity-85 disabled:opacity-50"
              >
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save settings"}
              </button>
              <div className="mt-6 border-t border-line pt-4">
                <p className="text-xs text-text-3">
                  Container memory and the app&apos;s port are Docker-level (set{" "}
                  <code className="rounded bg-surface px-1">LUMINA_MEM_LIMIT</code> and{" "}
                  <code className="rounded bg-surface px-1">LUMINA_PORT</code> in your{" "}
                  <code className="rounded bg-surface px-1">.env</code>), so they can&apos;t be changed
                  here.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
