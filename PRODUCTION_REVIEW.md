# Production-readiness review — findings & fix checklist

Consolidated from a three-way audit (server, frontend, ops/Docker/docs) on 2026-07-01.
Work through top to bottom; check items off as they land. Each item is self-contained
(file, problem, fix) so work can resume in a fresh session without re-deriving context.
Delete this file once everything is checked off and verified.

## P0 — correctness & security (high)

- [x] **A1. sortIndex race → photos silently missing from pagination.**
  `src/server/routes/admin/uploads.ts` (~line 135): `SELECT MAX(sort_index)+1` and the
  INSERT are separate awaits; 5 concurrent Uppy uploads interleave and insert duplicate
  sortIndex values. Both photo-list routes paginate with `gt(sortIndex, cursor)`, so a
  page boundary between two rows sharing a sortIndex silently drops the second row.
  Fix: fold the max+1 subquery into the INSERT itself (`sql` subquery as the sortIndex
  value) so assignment is one atomic statement.

- [x] **A2. index.html cached 1h → every deploy breaks the app for up to an hour.**
  `src/server/app.ts` (~line 45): `maxAge: "1h"` applies to everything including the SPA
  fallback. Vite assets are content-hashed; stale index.html requests 404ing chunks.
  Fix: `/assets/*` → `max-age=31536000, immutable`; `index.html` (and the not-found
  fallback) → `no-cache`. Use fastify-static `setHeaders`.

- [x] **A3. DB write per photo-byte request.** `src/server/services/auth.ts` (~line 67):
  `verifyAdminSession` does a sliding-expiry UPDATE on every call; the admin grid loads
  500+ thumbnails per view → hundreds of pointless writes. Fix: only UPDATE when
  `lastSeenAt` is older than 15 minutes.

- [x] **A4. Upload dedupe race orphans files and 500s.** `src/server/routes/admin/uploads.ts`
  (~line 110): two concurrent identical uploads both pass the dedupe SELECT; loser hits the
  `(gallery_id, checksum)` unique index → 500, and its already-renamed original stays
  orphaned on disk. Fix: try/catch the INSERT; on unique-constraint error, `rm` the renamed
  file and return the existing row as `{duplicate: true}`; on other errors `rm` and rethrow.

- [x] **A5. `failed` photos are permanently stuck.** No retry endpoint; `/uploads/check`
  counts failed rows as "existing" (folder re-select skips them); checksum dedupe returns
  `duplicate: true` on manual re-upload. Fix (in `uploads.ts`): exclude `failed` rows from
  the check's "existing" list, and in the dedupe path reset a failed existing row to
  `pending`/attempts 0 before returning it.

- [x] **A6. Admin login rate limit is spoofable via X-Forwarded-For.** `TRUST_PROXY=true`
  is unconditional; without a proxy an attacker rotates XFF per request and the per-IP
  backoff never triggers. Gallery unlock has a cross-IP per-gallery cap; admin login has
  none. Fix (`src/server/services/rateLimiter.ts`): add a global cross-IP failure cap for
  scope `admin_login` (e.g. 100 failures/hour), mirroring `checkPerGalleryCap`.

- [x] **A7. `/api/setup` race can create two admin accounts.** `src/server/routes/setup.ts`:
  exists-check, then ~100ms hash await, then INSERT — two concurrent POSTs both pass.
  Fix: `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM admin_users)` (raw sql via
  drizzle), treat 0 rows changed as 403.

- [x] **A8. Graceful shutdown never works.** Two stacked problems:
  (a) `Dockerfile` CMD is `sh -c "npm run db:migrate && npm start"` — `sh`/`npm` never
  forward SIGTERM, so every `docker stop` is a 10s hang + SIGKILL. Fix: entrypoint script
  that runs migrate then `exec node --import tsx src/server/index.ts` (exec so node is
  PID 1's direct child), plus `init: true` in compose.
  (b) Even then, open SSE connections make `app.close()` hang. Fix: `forceCloseConnections:
  true` in the Fastify factory options + race `app.close()` against a ~5s unref'd timeout
  in `src/server/index.ts`.

- [x] **A9. Old admin sessions survive the documented password-reset recovery.**
  sqlite3 CLI has foreign_keys OFF, so `DELETE FROM admin_users` doesn't cascade to
  `admin_sessions`, and `verifyAdminSession` never checks the admin row still exists →
  previously-logged-in browsers keep full access after a reset. Fix: verifyAdminSession
  joins/validates `admin_users`; README recovery becomes
  `DELETE FROM admin_sessions; DELETE FROM admin_users;`.

- [x] **F1. Admin grid silently truncates at 500 photos.**
  `src/web/routes/admin/galleries/AdminPhotoGrid.tsx`: single fetch `?limit=500`, ignores
  `nextCursor`; a 1400-photo gallery shows 500 with no hint. Fix: `useInfiniteQuery` with
  an IntersectionObserver sentinel (mirror client PhotoGrid), keep the SSE cache-patching
  working over the paged shape.

- [x] **F2. Client lightbox stops dead at the page boundary (180).**
  `src/web/routes/gallery/PhotoGrid.tsx`: slides only from loaded pages; swiping never
  triggers `fetchNextPage`. Fix: in the lightbox `on.view` callback, when
  `index >= photos.length - 5 && hasNextPage`, call `fetchNextPage()`.

## P1 — real bugs & operational gaps (medium)

- [x] **S9. Duplicate filenames collide inside downloaded ZIPs.**
  `src/server/routes/admin/export.ts` (~line 86): entry name is `originalFilename`; two
  photos named DSC_0001.jpg → extractors silently overwrite one. Fix: track seen names,
  suffix duplicates (`DSC_0001 (2).jpg`, before the extension).

- [x] **S11. Favorite double-tap can 500.** `src/server/routes/gallery/public.ts`
  (~line 146): check-then-insert races → unique-constraint 500 + confusing optimistic
  rollback. Fix: catch the constraint error and return `{favorited: true}`.

- [x] **F3+F4. photoCount stale + refetch storm after uploads.**
  `src/web/routes/admin/galleries/UploadPanel.tsx`: invalidates only the photo list, and
  does so per file (300-file batch = hundreds of refetches). Fix: throttle invalidation
  (≤1 per ~2s) and also invalidate `["admin-gallery", id]` + `["admin-galleries"]` on
  batch complete so the "Photos (N)" heading and list cards update.

- [x] **F5. Uppy Dashboard breaks in dev (StrictMode double-mount).**
  `UploadPanel.tsx`: `useState`-owned instance + `uppy.destroy()` in cleanup → second dev
  mount renders against a destroyed instance. Fix: don't destroy a useState-owned instance
  (the @uppy/react documented pattern).

- [x] **F7. Upload failures show generic "Upload error".** Server sends
  `invalid_file_type`/`file_too_large`/401 but XHRUpload surfaces none. Fix: XHRUpload
  `getResponseError` mapping response JSON → human message (esp. session expiry mid-batch).

- [x] **F8. No recovery when admin session expires mid-use.** Panels degrade to dead
  "couldn't load" states until hard reload. Fix: `QueryClient` global `QueryCache.onError`:
  on `ApiError.status === 401` from an `/api/admin/*` query, invalidate/reset
  `["admin-me"]` so the login form re-renders.

- [x] **O4. Unbounded Docker logs.** pino logs every photo request; default json-file
  driver never rotates → multi-GB on a NAS system disk. Fix: `logging` block in compose
  (`max-size: "10m"`, `max-file: "3"`).

- [x] **O5. `/data/photos/tmp` never swept.** Crash mid-upload orphans tmp files forever.
  Fix: boot-time sweep (in the maintenance sweep in `src/server/index.ts`) deleting tmp
  files older than 24h.

- [x] **S-extra. SQLite tuning + response compression.**
  `PRAGMA synchronous = NORMAL` in `src/server/db/client.ts` (recommended WAL pairing);
  register `@fastify/compress` (new dep) so the 259KB SPA bundle ships as ~82KB to phones.

## P2 — lower severity & polish

- [x] **S10. Suffix Range requests return wrong bytes.** `src/server/routes/photos.ts`:
  `bytes=-500` returns the FIRST 501 bytes as 206 (should be last 500). Fix: implement
  suffix semantics or treat empty-start as full 200.

- [x] **S12. `/uploads/check` has no body schema.** Add Fastify schema
  (array maxItems, string/number types) matching house style.

- [x] **S13. Missing dimensions stored as 0, not NULL.**
  `src/server/services/imagePipeline.ts` (~line 33): `?? 0` → frontend's `?? 800` guard
  misses 0 → NaN row heights. Fix: store null on falsy.

- [x] **F6. ThumbHash decoded in render, uncached.** `PhotoGrid.tsx`: every re-render
  (each heart tap) re-decodes every visible placeholder. Fix: module-level
  `Map<string, string>` memo inside `decodeThumbhash`.

- [x] **F9. SSE patch dropped for photos not in cache.** `AdminPhotoGrid.tsx`: events for
  unknown photoIds are lost (tile stuck on "Queued…"). Fix: when patch finds no matching
  photo, fire one invalidation instead.

- [x] **F10. Dedup check races autoProceed.** `UploadPanel.tsx`: uploads start before
  `/uploads/check` returns; already-uploaded bytes re-sent (server dedupes, bandwidth
  wasted). Fix: `autoProceed: false`, call `uppy.upload()` after the check resolves.

- [x] **C10. index.html basics.** No favicon (404 noise), no
  `<meta name="robots" content="noindex">` (private galleries shouldn't be indexed);
  `document.title` never reflects gallery name. Fix: inline SVG favicon, robots meta,
  set title in GalleryApp/AdminApp effects.

- [x] **C11. CreateGalleryDialog a11y.** `src/web/routes/admin/GalleryList.tsx`: no
  Escape-to-close, no `role="dialog"`/`aria-modal`, no focus handling.

- [x] **C12. Gallery cover photos never populated.** `galleries.cover_photo_id` is never
  set by any route, so admin gallery cards always show the placeholder gradient. Fix:
  worker sets `coverPhotoId` (if null) when a photo flips to ready; GalleryList renders
  `photoUrl(coverPhotoId, "thumb")` when present.

- [x] **O6. Backup writes aren't atomic.** `src/server/services/backup.ts`: crash
  mid-backup leaves a truncated snapshot in retention; partial `last-backup.json` breaks
  status parse. Fix: write both to temp names, then `rename`.

- [x] **O7. Remove unused dependency** `@tanstack/react-virtual` (zero imports).
  Keep `@uppy/dashboard` (peer dep of @uppy/react).

- [x] **O8. `.dockerignore` missing `.claude/`** (busts layer cache every build); add
  `*.md` too.

- [x] **O9. Doc drift.** `MAX_UPLOAD_FILE_SIZE_BYTES`/`HOST` undocumented; CLAUDE.md
  mentions `DATA_DIR` in `.env.example` but it's not there. Fix README config table +
  CLAUDE.md.

- [x] **O10. Add LICENSE file** (package.json declares ISC).

- [x] **O11. Memory guidance.** Commented `mem_limit: 1g` in compose + README note tying
  `UPLOAD_CONCURRENCY` to RAM on small NAS hardware.

## P3 — tests & final verification

- [x] **D1. Test suite (vitest).** API-level integration tests via `buildApp()` +
  `app.inject()` against a temp-dir DB (set `DATA_DIR`/`DATABASE_PATH` env before
  importing; run migrations programmatically): setup self-disable + race (A7), login +
  rate-limit lockout, gallery CRUD + passwordVersion bump on password change/removal,
  unlock anti-enumeration (identical 401s), favorites toggle idempotency, lightroom-list
  format, photo-byte route access control (403 without cookie / 200 with / cross-gallery
  denial). Unit test imagePipeline with a sharp-generated JPEG fixture (derivatives exist,
  thumbhash decodes, dimensions correct).

- [x] **E1. Final verification.** `npm run typecheck` + `npm run build` + `npm test` +
  dev-server smoke (setup → upload → favorite → lightroom list → zip) + README/CLAUDE.md
  accuracy pass over changed behavior + commit.

## Explicitly checked and clean (don't re-audit)

Anti-enumeration timing on unlock/login; rate-limiter streak reset + retention; worker
claim logic (single claimer) + boot reclaim + SSE listener cleanup; photo-byte route
re-validating access per request; tmp cleanup on handled upload failures; error handler
5xx opacity; compose/config env agreement; backup WAL-safety + retention sort; FK
cascades; Uppy CSS not leaking into client bundle; optimistic-favorite rollback logic;
EventSource/observer teardown; iOS sticky-header/viewport basics; runtime image has
sqlite3+curl, build tools don't leak into it; npm audit moderates are dev-only
(do NOT run `npm audit fix --force` — it downgrades drizzle-kit).
