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
RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 \
  && rm -rf /var/lib/apt/lists/*

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

CMD ["./docker-entrypoint.sh"]
