import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

const AdminApp = lazy(() => import("./routes/admin/AdminApp.tsx").then((m) => ({ default: m.AdminApp })));
const GalleryApp = lazy(() =>
  import("./routes/gallery/GalleryApp.tsx").then((m) => ({ default: m.GalleryApp })),
);

export function App() {
  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/g/:slug/*" element={<GalleryApp />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

function FullScreenLoader() {
  return (
    <div className="flex h-screen w-screen items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-text-1" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-2 text-text-3">
      <p className="text-lg font-medium text-text-1">Page not found</p>
      <p className="text-sm">Check the link and try again.</p>
    </div>
  );
}
