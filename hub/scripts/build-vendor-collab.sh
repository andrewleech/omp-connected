#!/usr/bin/env bash
# Builds the vendored OMP Collab guest client (upstream @oh-my-pi/collab-web,
# with local modifications — third-party analytics removed, room-key
# fragment kept out of browser history) and copies its output into
# dist/webui/collab, served at /collab/ by the omp-hub server.
#
# The client's source currently still lives in a sibling checkout,
# cc-pi-bridge/trial-omp/webui/collab-web — that repo is where OMP's
# extension-side trial work lives and this vendoring hasn't been physically
# relocated into omp-hub yet. This script is the seam: point
# COLLAB_WEB_SRC at wherever that source lives. The BUILT output is never
# committed to this repo (see .gitignore) — only the buildable source is a
# durable dependency, and today that source is external to this checkout.
set -euo pipefail

COLLAB_WEB_SRC="${COLLAB_WEB_SRC:-$HOME/cc-pi-bridge/trial-omp/webui/collab-web}"
OUT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/dist/webui/collab"

if [[ ! -d $COLLAB_WEB_SRC ]]; then
	echo "collab-web source not found at $COLLAB_WEB_SRC (set COLLAB_WEB_SRC to override)" >&2
	exit 1
fi

(cd "$COLLAB_WEB_SRC" && bun run build)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$COLLAB_WEB_SRC/dist/." "$OUT_DIR/"
echo "Built collab-web guest into $OUT_DIR"