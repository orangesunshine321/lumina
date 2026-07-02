#!/usr/bin/env bash
#
# Pixset one-line installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/orangesunshine321/pixset/main/install.sh | bash
#
# Installs into ./pixset (override with PIXSET_DIR), builds the Docker image,
# and starts the app. Safe to re-run: an existing install is updated in place —
# your data/ directory (photos, database, backups) is never touched.
#
# Optional environment variables:
#   PIXSET_DIR=/path/to/install     install/update location (default: ./pixset)
#   PIXSET_PORT=3005                host port if 3000 is taken (default: 3000)
set -euo pipefail

REPO="orangesunshine321/pixset"
BRANCH="main"
INSTALL_DIR="${PIXSET_DIR:-$(pwd)/pixset}"
PORT="${PIXSET_PORT:-3000}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Preflight ---------------------------------------------------------------

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar  >/dev/null 2>&1 || fail "tar is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required. Install it from https://docs.docker.com/get-docker/ and re-run."
docker info >/dev/null 2>&1 || fail "Docker is installed but the daemon isn't running (or you lack permission). Start Docker and re-run."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command). Update Docker and re-run."

if [ "$PORT" = "3000" ] && [ ! -e "$INSTALL_DIR/docker-compose.override.yml" ]; then
  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3000 >/dev/null 2>&1; then
    # Only a hard failure on FIRST install — an existing Pixset holding the
    # port is exactly what we expect during an update.
    if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then
      fail "Port 3000 is already in use. Re-run with a different port, e.g.: PIXSET_PORT=3005 bash install.sh"
    fi
  fi
fi

# --- Download ----------------------------------------------------------------

UPDATE=""
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  UPDATE="yes"
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
# Copy app files over the install dir. data/ is not in the repo tarball, so an
# existing library can't be overwritten by this.
cp -R "$SRC"/. "$INSTALL_DIR"/

# --- Port override -----------------------------------------------------------

if [ "$PORT" != "3000" ]; then
  say "Mapping Pixset to host port $PORT"
  cat > "$INSTALL_DIR/docker-compose.override.yml" <<EOF
# Written by install.sh because PIXSET_PORT=$PORT was set. Delete this file to
# return to the default port mapping in docker-compose.yml.
services:
  app:
    ports: !override
      - "127.0.0.1:$PORT:3000"
EOF
fi

# --- Build and start ---------------------------------------------------------

cd "$INSTALL_DIR"
say "Building the Docker image (a few minutes on first install)..."
docker compose build --quiet 2>/dev/null || docker compose build
say "Starting Pixset..."
docker compose up -d

say "Waiting for the app to come up..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    say "Pixset is running."
    echo
    echo "  Open:        http://localhost:$PORT"
    if [ -z "$UPDATE" ]; then
      echo "  First step:  create your admin account on the setup screen."
      echo "  Your data:   $INSTALL_DIR/data  (photos, database, backups — back this up)"
      echo "  Going live:  put a reverse proxy in front for HTTPS — see the README."
    fi
    echo
    exit 0
  fi
  sleep 1
done

fail "The app didn't respond on port $PORT within 30s. Check logs with: docker compose -f '$INSTALL_DIR/docker-compose.yml' logs"
