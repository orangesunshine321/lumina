# syntax=docker/dockerfile:1

# Debian bookworm-slim, not Alpine: sharp/libvips and better-sqlite3 ship
# glibc prebuilt binaries that are far more reliably available/tested here
# than fighting musl edge cases on Alpine.
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Safety net for any platform where a native module has no prebuilt binary
# (e.g. less common CPU architectures) and must compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The single source of truth for all on-disk state; everything (db, photos,
# backups, the auto-generated session secret) resolves under here. Must point
# at the mounted volume, not the image's ephemeral filesystem.
ENV DATA_DIR=/data
# gosu drops privileges cleanly for PID 1 (proper signal forwarding, no TTY);
# the app runs as the unprivileged `pixset` user, not root.
RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home --home-dir /home/pixset pixset

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle
COPY src/server ./src/server
COPY --from=build /app/dist/web ./dist/web
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Starts as root only long enough to fix /data ownership, then drops to
# `pixset` (see the entrypoint). Override with `user:` in compose if you need
# a specific host UID for the bind mount.
CMD ["./docker-entrypoint.sh"]
