import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { ApiError } from "./lib/api.ts";
import "./styles.css";

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // Central 401 recovery: when an admin session expires mid-use, drop back
    // to the login form instead of stranding panels in dead error states; when
    // a gallery cookie is invalidated (password changed), drop the client back
    // to the password gate. The gate queries themselves are excluded so their
    // own 401s can't loop.
    onError: (error, query) => {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      const keyRoot = query.queryKey[0];
      if (keyRoot === "admin-me" || keyRoot === "gallery-meta") return;
      queryClient.invalidateQueries({ queryKey: ["admin-me"] });
      queryClient.invalidateQueries({ queryKey: ["gallery-meta"] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
