import { defineConfig } from "vitest/config";

// Standalone config: vite.config.ts sets root to src/web (frontend-only), so
// without this vitest would never see the server tests.
export default defineConfig({
  test: {
    include: ["src/server/**/*.test.ts"],
    // Process isolation per test file: each file owns its own temp DATA_DIR,
    // SQLite handle (native module), and env mutations.
    pool: "forks",
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
