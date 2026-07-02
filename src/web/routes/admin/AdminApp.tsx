import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { api, ApiError } from "../../lib/api.ts";
import { SetupForm } from "./SetupForm.tsx";
import { LoginForm } from "./LoginForm.tsx";
import { AdminShell } from "./AdminShell.tsx";
import { GalleryList } from "./GalleryList.tsx";
import { GalleryDetail } from "./GalleryDetail.tsx";

interface Me {
  id: string;
  email: string;
}

export function AdminApp() {
  const queryClient = useQueryClient();

  useEffect(() => {
    document.title = "Pixset — Admin";
  }, []);

  const setupStatus = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<{ needsSetup: boolean }>("/api/setup/status"),
  });

  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => api.get<Me>("/api/admin/me"),
    enabled: setupStatus.data?.needsSetup === false,
    retry: false,
  });

  if (setupStatus.isLoading) return <CenteredSpinner />;

  if (setupStatus.data?.needsSetup) {
    return (
      <SetupForm
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["setup-status"] });
          queryClient.invalidateQueries({ queryKey: ["admin-me"] });
        }}
      />
    );
  }

  if (me.isLoading) return <CenteredSpinner />;

  if (me.isError) {
    const status = me.error instanceof ApiError ? me.error.status : 0;
    if (status === 401) {
      return (
        <LoginForm
          onComplete={() => queryClient.invalidateQueries({ queryKey: ["admin-me"] })}
        />
      );
    }
    return <CenteredError message="Something went wrong loading your account. Try reloading." />;
  }

  if (!me.data) return <CenteredSpinner />;

  return (
    <AdminShell admin={me.data}>
      <Routes>
        <Route path="/" element={<GalleryList />} />
        <Route path="/galleries/:id" element={<GalleryDetail />} />
      </Routes>
    </AdminShell>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex h-screen w-screen items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-text-1" />
    </div>
  );
}

function CenteredError({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center px-6 text-center text-text-3">
      {message}
    </div>
  );
}
