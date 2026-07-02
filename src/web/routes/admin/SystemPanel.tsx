import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import type { SystemStatsDTO } from "../../lib/types.ts";

/** Quiet one-row status strip at the bottom of the dashboard — enough to
 * answer "is everything healthy and how big is my library" at a glance
 * without turning the gallery list into a monitoring page. */
export function SystemPanel() {
  const stats = useQuery({
    queryKey: ["system"],
    queryFn: () => api.get<SystemStatsDTO>("/api/admin/system"),
    staleTime: 60_000,
  });

  // Informational only — render nothing rather than an error card.
  if (!stats.data) return null;
  const { version, backup, database, library, queue } = stats.data;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-ink-100 bg-white px-5 py-3 text-xs text-ink-400">
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
        <span className="font-medium text-ink-600">Backup</span>
        {backup.lastBackupAt ? new Date(backup.lastBackupAt).toLocaleString() : "not yet run"}
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

      <span className="ml-auto">Pixset v{version}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-medium text-ink-600">{label}</span>
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
