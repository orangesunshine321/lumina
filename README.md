# Pixset

A self-hosted, leaner alternative to Pixieset for one specific workflow: share a batch of exported JPEGs with a client, let them pick favorites in a fast, private gallery, and pull those picks straight back into Lightroom Classic to flag them for editing.

## What this is (and isn't)

**In scope:** galleries, bulk upload with live processing status, a fast justified photo grid with a lightbox, client favoriting (no client account needed), a one-click "Lightroom copy list" export, and download-all/download-favorites as a zip.

**Out of scope, on purpose:** no e-commerce/print store, no invoicing, no multi-user/team accounts (there's exactly one admin — you), no proofing comments or watermarking, and no Lightroom plugin or catalog file writing. The Lightroom "integration" is a clipboard button, nothing more — see [Using the Lightroom export](#using-the-lightroom-export) below.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose (bundled with Docker Desktop and modern Docker Engine installs).

```bash
git clone <this-repo> pixset && cd pixset
cp .env.example .env
```

Edit `.env` and set `SESSION_SECRET` (generate one with `openssl rand -hex 32`) and `PUBLIC_BASE_URL` (the URL clients will actually use, e.g. `https://photos.yourdomain.com`).

```bash
docker compose up -d
```

Open `PUBLIC_BASE_URL` (or `http://localhost:3000` if you haven't put a reverse proxy in front yet) and complete the one-time admin setup form. That's it — no separate database, no manual migration step (they run automatically on every container start).

## Configuration

All configuration is environment variables, set in `.env` (read by `docker-compose.yml`):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SESSION_SECRET` | Yes | — | `openssl rand -hex 32`. Signs gallery-access cookies. Changing it logs every client out of every gallery — keep it stable across restarts, and never commit it. |
| `PUBLIC_BASE_URL` | Recommended | `http://localhost:3000` | The URL clients use to reach the app. Used to build absolute gallery links in the admin UI. |
| `UPLOAD_CONCURRENCY` | No | `4` | How many photos process (thumbnail/preview generation) concurrently in the background. Lower it on low-core or low-RAM hardware — concurrent image processing is the app's main memory consumer. |
| `MAX_UPLOAD_FILE_SIZE_BYTES` | No | `52428800` (50MB) | Per-file upload size limit. |

There's deliberately no `ADMIN_EMAIL`/`ADMIN_PASSWORD` env var — the admin account is created once, in-app, via the setup form on first boot. That route permanently disables itself the instant an admin account exists.

## Putting a reverse proxy in front

The app itself only ever speaks plain HTTP on port 3000, bound to `127.0.0.1` in the provided `docker-compose.yml` — it deliberately never handles TLS itself. Pick whichever of these you already run:

**Caddy** (simplest — automatic HTTPS, ~5 lines):

```
photos.yourdomain.com {
	reverse_proxy 127.0.0.1:3000
}
```

**Cloudflare Tunnel** — no port forwarding needed at all, works well from behind CGNAT/no static IP. Point a tunnel at `http://localhost:3000`.

**Nginx Proxy Manager / plain Nginx** — a standard `proxy_pass http://127.0.0.1:3000;` reverse-proxy host with your certificate of choice works fine; just make sure `X-Forwarded-Proto` is forwarded (the app trusts it via `TRUST_PROXY=true`, already set in `docker-compose.yml`).

A commented-out example `caddy` service is included directly in `docker-compose.yml` if you'd rather not run a separate reverse proxy stack at all.

## Where you host it: home server vs. a small VPS

The default `docker-compose.yml` is written for a home server/NAS, and that works well. One thing worth knowing up front: your home internet's *upload* bandwidth is what both your photo uploads **and** your clients' browsing traffic ride on — most home connections are asymmetric (much faster download than upload), so if a gallery feels sluggish for clients, that's almost always why.

If that turns out to matter to you, the fix needs zero code changes: run the exact same `docker compose up` on a small VPS instead (Hetzner, DigitalOcean, etc. — a few dollars a month is plenty for this workload). Your one-time upload of a shoot to the VPS still rides your home connection, but it happens once in the background — you don't wait on it. Every client view afterward comes from the VPS's typically much better, often-symmetric bandwidth, completely decoupling your clients' experience from your home connection. There's no other migration involved: same image, same compose file, same `./data` layout.

## Using Pixset

1. **Create a gallery.** From the admin dashboard, click "New gallery," give it a title (e.g. the client's name/shoot). You land on the gallery's detail page.
2. **Upload.** Drag a folder of exported JPEGs onto the upload panel. Files upload with live per-file and overall progress; each photo flips from a processing placeholder to a real thumbnail as background processing (thumbnail/preview generation) finishes — you don't need to wait for the whole batch before the grid starts filling in. If a browser tab closes or Wi-Fi drops mid-batch, just reopen the gallery and re-select the same folder — already-uploaded files are detected and skipped automatically.
3. **Set a password (optional) and copy the link.** In the gallery's settings panel, optionally set a password, then copy the shareable link and send it to your client. No account or login is ever required on their end.
4. **Your client browses and favorites.** They open the link (entering the password if you set one), browse the grid, and tap hearts to pick favorites. Their picks are saved automatically and persist if they come back later, on any device, without an account.
5. **Pull picks into Lightroom.** See below.

### Using the Lightroom export

This is the whole point of the app. On the gallery's detail page, the **Lightroom export** panel shows every currently-favorited photo and a **"Copy Lightroom List"** button. Clicking it copies a comma-separated list of the *original* filenames (extension stripped) to your clipboard, e.g.:

```
DSC_1001, DSC_1014, DSC_1032, DSC_1058
```

In Lightroom Classic:

1. Open the Library module and the Filter bar (`\` if it's hidden).
2. Choose **Text** search, set the field to **Filename**, and set the match mode to **Any** (not "Contains" — Any lets a single paste match every filename in the list at once).
3. Paste. Every picked photo is now selected/filtered — flag, apply a color label, or start editing.

No plugin, no XMP sidecar writing, no catalog scripting — just a clipboard button and Lightroom's own filter bar.

## Backups

**The database backs itself up automatically** — a consistent snapshot (safe to run against the live database, no downtime) is written to `data/db/backups/` once at startup and then once every 24 hours, with the last 14 daily snapshots kept and older ones pruned. Nothing to configure. If it ever stops running for some reason, a warning banner appears in the admin UI.

**Photo files are not included in that automatic snapshot** (they're large, and re-processing thumbnails from a re-uploaded original is always possible — but favorites and gallery metadata have no other copy anywhere, which is why *that* part is automatic and mandatory). For full disaster recovery — protecting against a dead drive, not just a bad deploy — back up the entire `./data` directory yourself, on a schedule, to somewhere else. [restic](https://restic.net/) is a good fit: a single static binary, encrypted, deduplicated, incremental, and backend-agnostic (a second drive, another machine over SFTP, or cloud storage all work the same way).

Example (adjust the repository target to whatever you have — a second local disk, a NAS over SFTP, or a cloud bucket all work):

```bash
export RESTIC_REPOSITORY=/mnt/backup-drive/pixset-restic
export RESTIC_PASSWORD=<a-strong-password-you-store-somewhere-safe>
restic init                               # once, ever
restic backup /path/to/pixset/data        # run this on a schedule (e.g. a nightly host cron job)
restic forget --keep-daily 14 --keep-weekly 8 --prune
```

**Restore:** stop the container, replace `./data` with your backed-up copy (or just `data/db/` plus `data/photos/originals/` if you only need the essentials — derivatives regenerate on next boot for anything missing), start the container again. No service-specific restore tooling to relearn.

## Updating

```bash
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on every container start — there's no separate migration step.

## Troubleshooting

**Forgot the admin password.** There's no email-based reset flow (out of scope by design — this is a single-admin tool). Recovery is one SQL statement:

```bash
docker compose exec app sh -c 'sqlite3 /data/db/app.sqlite "DELETE FROM admin_sessions; DELETE FROM admin_users;"'
```

(Both tables: the sqlite3 CLI doesn't enforce foreign keys by default, so deleting only
the account would leave old logged-in browser sessions orphaned.)

Reload the app — the one-time setup form reappears, ready to create a fresh admin account. (Existing galleries, photos, and favorites are untouched; only the admin login itself is reset.)

**Permission errors on `./data`.** The container currently runs as root for the simplest possible bind-mount story on a home NAS. If you'd rather run it as a non-root user, add a `user: "1000:1000"` (matching your host UID/GID) to the `app` service in `docker-compose.yml` and `chown -R 1000:1000 ./data` once beforehand.

**Port 3000 already in use.** Change the host-side port in `docker-compose.yml`'s `ports:` mapping (e.g. `"127.0.0.1:3005:3000"`) and point your reverse proxy at the new port.

## Stack

Fastify + SQLite (via Drizzle) + sharp on the backend; React + Vite (no SSR — private galleries have no SEO value) on the frontend. Everything runs as a single Docker service — no Postgres, no Redis, no separate worker container, no required cloud dependency. See the architecture notes in the repo history if you want the full rationale behind each choice.
