#!/usr/bin/env bash
#
# Pixset one-line installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/orangesunshine321/pixset/main/install.sh | bash
#
# Installs into ./pixset (override with PIXSET_DIR), starts the app on port
# 7373 (override with PIXSET_PORT), preferring the prebuilt image and falling
# back to a local build. Safe to re-run: an existing install is updated in
# place — your data/ directory (photos, database, backups) is never touched.
#
#   curl -fsSL .../install.sh | PIXSET_PORT=4444 bash        # custom port
#   curl -fsSL .../install.sh | PIXSET_DIR=~/apps/pixset bash # custom location
#
# The port can also be changed any time AFTER install: edit PIXSET_PORT in
# the install directory's .env file and run `docker compose up -d`.
set -euo pipefail

REPO="orangesunshine321/pixset"
BRANCH="main"
DEFAULT_PORT=7373
INSTALL_DIR="${PIXSET_DIR:-$(pwd)/pixset}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

port_in_use() {
  command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# --- Preflight ---------------------------------------------------------------

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar  >/dev/null 2>&1 || fail "tar is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required. Install it from https://docs.docker.com/get-docker/ and re-run."
docker info >/dev/null 2>&1 || fail "Docker is installed but the daemon isn't running (or you lack permission). Start Docker and re-run."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command). Update Docker and re-run."

UPDATE=""
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  UPDATE="yes"
fi

# --- Pick a port -------------------------------------------------------------
# Priority: explicit PIXSET_PORT > the existing install's .env > default.

PORT="${PIXSET_PORT:-}"
if [ -z "$PORT" ] && [ -n "$UPDATE" ] && [ -f "$INSTALL_DIR/.env" ]; then
  PORT="$(grep '^PIXSET_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -cd '0-9')"
fi
PORT="${PORT:-$DEFAULT_PORT}"
valid_port "$PORT" || fail "PIXSET_PORT must be a number between 1024 and 65535 (got: $PORT)."

# On a fresh install, a busy port means a conflict with something else. On an
# update, the port being busy is expected — it's the running Pixset itself.
if [ -z "$UPDATE" ] && port_in_use "$PORT"; then
  # Probe by actually opening /dev/tty: permission tests pass on macOS even
  # without a controlling terminal, but the open itself fails there.
  if { : < /dev/tty; } 2>/dev/null; then
    say "Port $PORT is already in use by another app."
    for attempt in 1 2 3; do
      printf 'Enter a different port for Pixset (1024-65535): ' > /dev/tty
      read -r PORT < /dev/tty
      if ! valid_port "$PORT"; then
        printf 'Not a valid port.\n' > /dev/tty
        continue
      fi
      if port_in_use "$PORT"; then
        printf 'Port %s is also in use.\n' "$PORT" > /dev/tty
        continue
      fi
      break
    done
    valid_port "$PORT" && ! port_in_use "$PORT" || fail "Couldn't find a free port. Re-run with one, e.g.: curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh | PIXSET_PORT=4444 bash"
  else
    fail "Port $PORT is already in use. Choose another port like this:
  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh | PIXSET_PORT=4444 bash"
  fi
fi

# --- Download ----------------------------------------------------------------

if [ -n "$UPDATE" ]; then
  say "Existing install found — updating in place (your data/ directory is untouched)."
else
  say "Installing Pixset into $INSTALL_DIR"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading the latest Pixset..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP"
SRC="$TMP/$(ls "$TMP")"

mkdir -p "$INSTALL_DIR"
# Copy app files over the install dir. data/ and .env are not in the repo
# tarball, so an existing library and settings can't be overwritten by this.
cp -R "$SRC"/. "$INSTALL_DIR"/

# --- Persist the port in .env (compose reads it automatically) ----------------

cd "$INSTALL_DIR"
touch .env
if grep -q '^PIXSET_PORT=' .env; then
  sed -i.tmp "s/^PIXSET_PORT=.*/PIXSET_PORT=$PORT/" .env && rm -f .env.tmp
else
  printf 'PIXSET_PORT=%s\n' "$PORT" >> .env
fi

# --- Start (prebuilt image preferred; local build as fallback) ----------------

if docker compose pull app >/dev/null 2>&1; then
  say "Using the prebuilt image."
  docker compose up -d --no-build
else
  say "Prebuilt image unavailable — building locally (a few minutes)..."
  docker compose build --quiet 2>/dev/null || docker compose build
  docker compose up -d
fi

say "Waiting for the app to come up..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    say "Pixset is running."
    echo
    echo "  Open:         http://localhost:$PORT"
    if [ -z "$UPDATE" ]; then
      echo "  First step:   create your admin account on the setup screen."
      echo "  Your data:    $INSTALL_DIR/data  (photos, database, backups — back this up)"
      echo "  Change port:  edit PIXSET_PORT in $INSTALL_DIR/.env, then 'docker compose up -d'"
      echo "  Going live:   put a reverse proxy in front for HTTPS — see the README."
    fi
    echo
    exit 0
  fi
  sleep 1
done

fail "The app didn't respond on port $PORT within 30s. Check logs with: docker compose -f '$INSTALL_DIR/docker-compose.yml' logs"
