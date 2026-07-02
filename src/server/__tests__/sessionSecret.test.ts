/**
 * Verifies the zero-config SESSION_SECRET path: no env var → a secret is
 * generated on first load and persisted under DATA_DIR so restarts keep the
 * same key (a changing key would log every client out of every gallery).
 * Deliberately does NOT import helpers.ts, which sets SESSION_SECRET.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pixset-secret-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "production";
delete process.env.SESSION_SECRET;

const { config } = await import("../config.ts");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("session secret auto-generation", () => {
  it("generates a strong secret and persists it for reuse across restarts", () => {
    expect(config.sessionSecret).toMatch(/^[0-9a-f]{64}$/);

    const secretPath = join(dataDir, "db", "session-secret");
    const persisted = readFileSync(secretPath, "utf-8").trim();
    expect(persisted).toBe(config.sessionSecret);

    // Owner-only permissions — it's a signing key sitting on disk.
    const mode = statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("prefers an explicit env var over the persisted file", async () => {
    // Fresh module registry isn't available mid-file, but the resolution
    // logic is pure enough to verify through a second dynamic import with a
    // cache-busting query — vitest serves the same module, so instead assert
    // the documented contract directly: env wins when present.
    process.env.SESSION_SECRET = "explicit-secret-abcdef0123456789abcdef0123456789";
    // @ts-expect-error — the query string is a Vite cache-buster so the module
    // re-executes with the new env; TS can't resolve the suffixed specifier.
    const fresh = await import("../config.ts?env-override");
    expect(fresh.config.sessionSecret).toBe("explicit-secret-abcdef0123456789abcdef0123456789");
    delete process.env.SESSION_SECRET;
  });
});
