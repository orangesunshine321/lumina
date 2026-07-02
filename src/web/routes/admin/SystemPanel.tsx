import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { SystemStatsDTO } from "../../lib/types.ts";

/** Quiet one-row status strip at the bottom of the dashboard — enough to
 * answer "is everything healthy and how big is my library" at a glance
 * without turning the gallery list into a monitoring page. */
export function SystemPanel() {
  const queryClient = useQueryClient();
  const [backingUp, setBackingUp] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const stats = useQuery({
    queryKey: ["system"],
    queryFn: () => api.get<SystemStatsDTO>("/api/admin/system"),
    staleTime: 60_000,
  });

  // Informational only — render nothing rather than an error card.
  if (!stats.data) return null;
  const { version, backup, database, library, queue } = stats.data;

  async function runBackupNow() {
    setBackingUp(true);
    try {
      const fresh = await api.post<SystemStatsDTO["backup"]>("/api/admin/backup/run");
      queryClient.setQueryData<SystemStatsDTO>(["system"], (old) =>
        old ? { ...old, backup: fresh } : old,
      );
      queryClient.invalidateQueries({ queryKey: ["backup-status"] });
      setBackupDone(true);
      setTimeout(() => setBackupDone(false), 2000);
    } finally {
      setBackingUp(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-line bg-surface px-5 py-3 text-xs text-text-3">
      <Stat label="Galleries" value={String(library.galleries)} />
      <Stat label="Photos" value={String(library.photos)} />
      <Stat label="Library" value={formatBytes(library.originalsBytes)} />
      <Stat label="Database" value={formatBytes(database.sizeBytes)} />

      <span className={`flex items-center gap-1.5 ${backup.isStale ? "text-accent-500" : ""}`}>
        {backup.isStale && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <path
              d="M12 9v4m0 4h.01M10.29 3.86l-8.18 14.18A1.5 1.5 0 0 0 3.34 20h17.32a1.5 1.5 0 0 0 1.23-1.96L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span className="font-medium text-text-2">Backup</span>
        {backup.lastBackupAt ? new Date(backup.lastBackupAt).toLocaleString() : "not yet run"}
      </span>

      <span className="flex items-center gap-3">
        <button
          onClick={() => void runBackupNow()}
          disabled={backingUp}
          className="font-medium text-text-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-text-1 disabled:opacity-50"
        >
          {backingUp ? "Backing up…" : backupDone ? "Done" : "Back up now"}
        </button>
        {backup.lastBackupAt ? (
          <a
            href="/api/admin/backup/download"
            className="font-medium text-text-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-text-1"
          >
            Download backup
          </a>
        ) : (
          <span className="cursor-not-allowed font-medium text-text-3/60">Download backup</span>
        )}
      </span>

      {(queue.pending > 0 || queue.processing > 0) && (
        <Stat label="Processing" value={`${queue.processing} active, ${queue.pending} queued`} />
      )}
      {queue.failed > 0 && (
        <span className="flex items-center gap-1.5 text-accent-500">
          <span className="font-medium">Failed</span>
          {queue.failed} {queue.failed === 1 ? "photo" : "photos"}
        </span>
      )}

      <span className="ml-auto">Lumina v{version}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-medium text-text-2">{label}</span>
      {value}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
