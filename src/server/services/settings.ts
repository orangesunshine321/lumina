import { db, schema } from "../db/client.ts";
import { config } from "../config.ts";

/**
 * Operator-tunable settings, editable live from the admin panel. Each value is
 * stored JSON-encoded in the `app_settings` table; anything absent falls back
 * to its env/config default, so a fresh install behaves exactly as before.
 * Reads are cached in-process and the cache is dropped on any update, so the
 * worker/pipeline pick up changes within a batch — no restart needed.
 *
 * Only APP-level knobs live here. Container memory and the published port are
 * Docker-level and can't be changed by the app itself; they're surfaced
 * read-only in the settings API from the environment.
 */
export interface AppSettings {
  generateAvif: boolean;
  uploadConcurrency: number;
  maxUploadFileSizeBytes: number;
  maxImagePixels: number;
}

// Hard ceilings the admin UI can't exceed. The upload ceiling is also the
// multipart plugin's fixed byte cap (see app.ts), so the runtime limit is
// always enforceable in-handler beneath it.
export const MIN_UPLOAD_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
export const MAX_UPLOAD_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const MIN_IMAGE_PIXELS = 1_000_000; // 1 MP
export const MAX_IMAGE_PIXELS = 500_000_000; // 500 MP
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

interface Definition {
  default: () => number | boolean;
  parse: (value: unknown) => number | boolean;
}

const DEFINITIONS: Record<keyof AppSettings, Definition> = {
  generateAvif: {
    default: () => config.generateAvif,
    parse: (v) => Boolean(v),
  },
  uploadConcurrency: {
    default: () => config.uploadConcurrency,
    parse: (v) => clampInt(v, MIN_CONCURRENCY, MAX_CONCURRENCY),
  },
  maxUploadFileSizeBytes: {
    default: () => config.maxUploadFileSizeBytes,
    parse: (v) => clampInt(v, MIN_UPLOAD_FILE_SIZE_BYTES, MAX_UPLOAD_FILE_SIZE_BYTES),
  },
  maxImagePixels: {
    default: () => config.maxImagePixels,
    parse: (v) => clampInt(v, MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS),
  },
};

const KEYS = Object.keys(DEFINITIONS) as (keyof AppSettings)[];

/** Ranges the admin UI / setup screen render and the server clamps to. */
export const SETTINGS_LIMITS = {
  uploadConcurrency: { min: MIN_CONCURRENCY, max: MAX_CONCURRENCY },
  maxUploadFileSizeBytes: { min: MIN_UPLOAD_FILE_SIZE_BYTES, max: MAX_UPLOAD_FILE_SIZE_BYTES },
  maxImagePixels: { min: MIN_IMAGE_PIXELS, max: MAX_IMAGE_PIXELS },
};

let cache: AppSettings | null = null;

/** Current effective settings (DB overrides merged over env defaults). Cached;
 * cheap to call per batch / per photo. */
export async function getSettings(): Promise<AppSettings> {
  if (!cache) cache = await loadSettings();
  return cache;
}

async function loadSettings(): Promise<AppSettings> {
  const rows = await db.select().from(schema.appSettings);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result = {} as AppSettings;
  for (const key of KEYS) {
    const def = DEFINITIONS[key];
    const raw = stored.get(key);
    if (raw !== undefined) {
      try {
        result[key] = def.parse(JSON.parse(raw)) as never;
        continue;
      } catch {
        // corrupt/legacy value — fall back to the default below
      }
    }
    result[key] = def.default() as never;
  }
  return result;
}

/** Validate + persist a partial update, then return the new effective settings.
 * Unknown keys are ignored; every value is clamped to its allowed range. */
export async function updateSettings(patch: Partial<Record<keyof AppSettings, unknown>>): Promise<AppSettings> {
  const now = new Date();
  for (const key of KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const value = DEFINITIONS[key].parse(patch[key]);
    const encoded = JSON.stringify(value);
    await db
      .insert(schema.appSettings)
      .values({ key, value: encoded, updatedAt: now })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: encoded, updatedAt: now } });
  }
  cache = null; // next getSettings() reloads with the new values
  return getSettings();
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
