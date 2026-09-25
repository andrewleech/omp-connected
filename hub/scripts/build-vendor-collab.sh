#!/usr/bin/env bash
# Builds the upstream @oh-my-pi/collab-web guest and copies its output into
# dist/webui/collab, served at /collab/ by the omp-hub server.
#
# The guest is pinned as the clean upstream oh-my-pi submodule under vendor/.
# COLLAB_WEB_SRC may override it with another compatible checkout's
# packages/collab-web directory. The built output is never committed to this
# repository (see .gitignore).
set -euo pipefail

HUB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COLLAB_WEB_SRC="${COLLAB_WEB_SRC:-$HUB_DIR/vendor/collab-web/packages/collab-web}"
OUT_DIR="$HUB_DIR/dist/webui/collab"

if [[ ! -d $COLLAB_WEB_SRC ]]; then
	echo "collab-web source not found at $COLLAB_WEB_SRC; initialize hub/vendor/collab-web or set COLLAB_WEB_SRC" >&2
	exit 1
fi

# collab-web is one package in the oh-my-pi bun workspace; install only its
# dependencies (at the workspace root, from the pinned lockfile).
WORKSPACE_ROOT="$(git -C "$COLLAB_WEB_SRC" rev-parse --show-toplevel)"
(cd "$WORKSPACE_ROOT" && bun install --frozen-lockfile --filter @oh-my-pi/collab-web)
(cd "$COLLAB_WEB_SRC" && bun run build)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$COLLAB_WEB_SRC/dist/." "$OUT_DIR/"
echo "Built collab-web guest into $OUT_DIR"