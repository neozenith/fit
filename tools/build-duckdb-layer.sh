#!/usr/bin/env bash
# Build the DuckDB Lambda layer (ADR-0025).
#
# The layer carries two things the API cannot get any other way at runtime:
#
#   nodejs/node_modules/@duckdb/**   the native binding, built for linux-arm64
#   duckdb-extensions/<v>/<plat>/*   httpfs and aws, pre-downloaded
#
# Both exist because of the same constraint: a deployed Lambda must not fetch
# anything at cold start. `INSTALL httpfs` reaches extensions.duckdb.org and
# writes into $HOME, which on Lambda is read-only — so an un-baked extension
# fails on the first cost query, in production, with a message about a missing
# extension rather than about a missing layer.
#
# TIER A (see .claude/rules/claude_skills/environments.md): requires `npm`,
# `curl` and network access to registry.npmjs.org and extensions.duckdb.org.
# There is no stdlib fallback and there must not be — a layer assembled from
# whatever happens to be on the machine is exactly the failure this guards.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/api/.layer}"

# One source of truth for the version: whatever the API actually imports.
# Reading it here rather than pinning it twice means a `bun add` bump cannot
# leave the layer a version behind — a mismatch that surfaces as a NAPI ABI
# error nobody reads as "the layer is stale".
NODE_API_VERSION="$(
  grep -o '"@duckdb/node-api": *"[^"]*"' "$ROOT/api/package.json" |
    sed 's/.*: *"//; s/"//'
)"
[ -n "$NODE_API_VERSION" ] || {
  echo "error: @duckdb/node-api is not a dependency of api/package.json" >&2
  exit 1
}

# The npm package is versioned `1.5.5-r.3` — DuckDB's own version plus a
# packaging revision. The extension repository is keyed on the DuckDB version
# alone, so the suffix is stripped.
DUCKDB_VERSION="v${NODE_API_VERSION%%-*}"

# Lambda arm64 runs Amazon Linux 2023 (glibc), not musl.
NODE_PLATFORM="linux-arm64"
EXT_PLATFORM="linux_arm64"
EXTENSIONS=(httpfs aws)

echo "duckdb: node-api $NODE_API_VERSION, engine $DUCKDB_VERSION, $EXT_PLATFORM"

mkdir -p "$ROOT/tmp"
STAGE="$ROOT/tmp/duckdb-layer-stage"
mkdir -p "$STAGE"
find "$STAGE" -mindepth 1 -maxdepth 1 -exec mv -f {} "$ROOT/tmp/" \; 2>/dev/null || true

# --- The native binding ------------------------------------------------------
#
# `npm`, not `bun`, and this is the one place in the repo where that is correct:
# the binding is chosen by OPTIONAL DEPENDENCY on `os`/`cpu`, and only npm can
# be told to resolve for a host it is not running on. `bun install` on an x86
# CI runner (or a macOS laptop) silently produces a layer with the wrong
# architecture, which fails at cold start with a module-resolution error that
# says nothing about architecture at all.
#
# `--include=optional` is load-bearing and was not obvious: with `--os`/`--cpu`
# set but optional deps omitted, npm resolves NOTHING for either platform and
# exits 0 having installed 1.6MB of JavaScript with no binary in it. The build
# succeeds, the layer publishes, and the failure lands at runtime.
mkdir -p "$STAGE/nodejs"
npm install \
  --prefix "$STAGE/nodejs" \
  --os=linux --cpu=arm64 --libc=glibc \
  --include=optional --omit=dev \
  --no-audit --no-fund --silent \
  "@duckdb/node-api@$NODE_API_VERSION"

BINDING="$STAGE/nodejs/node_modules/@duckdb/node-bindings-$NODE_PLATFORM/duckdb.node"
[ -f "$BINDING" ] || {
  echo "error: $NODE_PLATFORM binding missing from the layer — refusing to publish" >&2
  exit 1
}

# npm writes a package.json and lockfile describing the staging directory, not
# the layer. Left in place they would make `/opt/nodejs` look like a package
# root and change module resolution for the handler.
rm -f "$STAGE/nodejs/package.json" "$STAGE/nodejs/package-lock.json"

# --- The extensions ----------------------------------------------------------
#
# Laid out exactly as DuckDB's `extension_directory` expects, so the query path
# can `LOAD httpfs` by name with autoinstall disabled. Loading by name from a
# baked directory keeps the SQL identical to the local-development path, where
# the same extensions come from the developer's own ~/.duckdb.
EXT_DIR="$STAGE/duckdb-extensions/$DUCKDB_VERSION/$EXT_PLATFORM"
mkdir -p "$EXT_DIR"
for ext in "${EXTENSIONS[@]}"; do
  url="https://extensions.duckdb.org/$DUCKDB_VERSION/$EXT_PLATFORM/$ext.duckdb_extension.gz"
  echo "  fetch $ext"
  curl -fsSL "$url" | gunzip >"$EXT_DIR/$ext.duckdb_extension"
  [ -s "$EXT_DIR/$ext.duckdb_extension" ] || {
    echo "error: $ext extension is empty" >&2
    exit 1
  }
done

# --- Publish the staged tree -------------------------------------------------
mkdir -p "$(dirname "$OUT")"
if [ -e "$OUT" ]; then
  mkdir -p "$ROOT/tmp/_archived"
  mv -f "$OUT" "$ROOT/tmp/_archived/duckdb-layer-$$"
fi
mv "$STAGE" "$OUT"

echo "layer: $OUT ($(du -sh "$OUT" | cut -f1))"
