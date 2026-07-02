import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { getTheme, toggleTheme, type Theme } from "../../lib/theme.ts";
import type { SystemStatsDTO } from "../../lib/types.ts";
import { AccountDialog } from "./AccountDialog.tsx";

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
  const [accountOpen, setAccountOpen] = useState(false);

  const backupStatus = useQuery({
    queryKey: ["backup-status"],
    queryFn: () => api.get<BackupStatus>("/api/admin/backup-status"),
    staleTime: 5 * 60_000,
  });

  // Shares the ["system"] key with SystemPanel, so this is a free read (one
  // fetch, deduped). Only the low-disk flag is used here for the banner.
  const system = useQuery({
    queryKey: ["system"],
    queryFn: () => api.get<SystemStatsDTO>("/api/admin/system"),
    staleTime: 60_000,
  });
  const lowDisk = system.data?.disk.lowSpace ?? false;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link
            to="/admin"
            className="font-display text-lg font-medium tracking-tight text-text-1"
          >
            Lumina
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <AccountMenu email={admin.email} onOpenSettings={() => setAccountOpen(true)} />
          </div>
        </div>
      </header>

      {lowDisk && (
        <Banner>
          Disk space is running low on the server. Delete old galleries to free
          space, or expand the volume — uploads will start failing when it fills.
        </Banner>
      )}

      {backupStatus.data?.isStale && (
        <Banner>
          {backupStatus.data.lastBackupAt
            ? `Database backup hasn't run recently (last: ${new Date(backupStatus.data.lastBackupAt).toLocaleString()}). Check the server logs.`
            : "No database backup yet — one runs automatically shortly after the server starts."}
        </Banner>
      )}

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>

      {accountOpen && <AccountDialog email={admin.email} onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-accent-500/20 bg-accent-500/10">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 text-xs text-accent-400 sm:px-6">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 shrink-0">
          <path
            d="M12 9v4m0 4h.01M10.29 3.86l-8.18 14.18A1.5 1.5 0 0 0 3.34 20h17.32a1.5 1.5 0 0 0 1.23-1.96L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{children}</span>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  return (
    <button
      onClick={() => setThemeState(toggleTheme())}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="tap-target flex items-center justify-center rounded-lg text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1"
    >
      {theme === "dark" ? (
        // Sun — offered action: go light.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4.5 w-4.5">
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        // Moon — offered action: go dark.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4.5 w-4.5">
          <path
            d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

function AccountMenu({ email, onOpenSettings }: { email: string; onOpenSettings: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleSignOut() {
    await api.post("/api/admin/logout");
    queryClient.setQueryData(["admin-me"], undefined);
    queryClient.invalidateQueries({ queryKey: ["admin-me"] });
  }

  async function handleSignOutEverywhere() {
    if (!window.confirm("Sign out on every device, including this one?")) return;
    await api.post("/api/admin/account/logout-all");
    queryClient.setQueryData(["admin-me"], undefined);
    queryClient.invalidateQueries({ queryKey: ["admin-me"] });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="tap-target flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1"
      >
        <span className="max-w-[160px] truncate">{email}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-line-strong bg-surface-2 py-1 shadow-xl shadow-black/20"
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Account settings
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              void handleSignOutEverywhere();
            }}
          >
            Sign out everywhere
          </MenuItem>
          <div className="my-1 border-t border-line" />
          <MenuItem onClick={() => void handleSignOut()}>Sign out</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="block w-full px-4 py-2 text-left text-sm text-text-1 transition-colors hover:bg-surface-3"
    >
      {children}
    </button>
  );
}
