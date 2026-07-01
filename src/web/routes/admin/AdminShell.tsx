import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";

interface BackupStatus {
  lastBackupAt: string | null;
  isStale: boolean;
}

export function AdminShell({
  admin,
  children,
}: {
  admin: { email: string };
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  const backupStatus = useQuery({
    queryKey: ["backup-status"],
    queryFn: () => api.get<BackupStatus>("/api/admin/backup-status"),
    staleTime: 5 * 60_000,
  });

  async function handleLogout() {
    await api.post("/api/admin/logout");
    queryClient.setQueryData(["admin-me"], undefined);
    queryClient.invalidateQueries({ queryKey: ["admin-me"] });
  }

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="sticky top-0 z-10 border-b border-ink-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link to="/admin" className="text-base font-semibold tracking-tight text-ink-900">
            Pixset
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-ink-400 sm:inline">{admin.email}</span>
            <button
              onClick={handleLogout}
              className="tap-target rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {backupStatus.data?.isStale && (
        <div className="border-b border-accent-500/20 bg-accent-500/5">
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 text-xs text-accent-500 sm:px-6">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 shrink-0">
              <path
                d="M12 9v4m0 4h.01M10.29 3.86l-8.18 14.18A1.5 1.5 0 0 0 3.34 20h17.32a1.5 1.5 0 0 0 1.23-1.96L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>
              {backupStatus.data.lastBackupAt
                ? `Database backup hasn't run recently (last: ${new Date(backupStatus.data.lastBackupAt).toLocaleString()}). Check the server logs.`
                : "No database backup yet — one runs automatically shortly after the server starts."}
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
