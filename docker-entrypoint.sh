#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_USER=lumina

# The app runs unprivileged. When started as root (the default), make sure the
# data volume is writable by the app user, then drop privileges. The ownership
# fix is skipped once /data already belongs to the app user, so a large photo
# library is only chowned once (on first boot / upgrade from an older root
# image), never on every restart.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "10001" ]; then
    echo "Preparing data directory ownership (one-time)…"
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  fi
  RUN="gosu $APP_USER"
else
  # Already running as a non-root user (e.g. compose `user:` override) — just
  # run directly and trust the operator mounted a writable volume.
  RUN=""
fi

$RUN node_modules/.bin/tsx src/server/db/migrate.ts

# exec so node replaces this shell as the container's main process — otherwise
# SIGTERM from `docker stop` never reaches the server and every shutdown ends
# in a 10s hang followed by SIGKILL.
exec $RUN node_modules/.bin/tsx src/server/index.ts
