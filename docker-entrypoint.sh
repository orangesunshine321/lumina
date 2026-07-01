#!/bin/sh
set -e

node_modules/.bin/tsx src/server/db/migrate.ts

# exec so node replaces this shell as the container's main process — otherwise
# SIGTERM from `docker stop` never reaches the server and every shutdown ends
# in a 10s hang followed by SIGKILL.
exec node_modules/.bin/tsx src/server/index.ts
