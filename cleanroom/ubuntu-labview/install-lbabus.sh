#!/usr/bin/env bash
# install-lbabus.sh — install the pinned, self-contained lbabus onto the Ubuntu golden box.
#
# The mesh actors coordinate over `lbabus net` (TCP 7420 / UDP 7421). lbabus is a .NET tool, but the
# collab-cli-v* release publishes a SELF-CONTAINED single-file linux-x64 binary (the runtime is bundled),
# so the actors need NO dotnet runtime + no `dotnet tool install`. Run this on the GOLDEN box BEFORE
# `vagrant package`, so every mesh clone inherits the SAME pinned lbabus (cross-plane version parity with
# the host + the Windows reviewer box).
#
# Token-less mesh-clone path: internal-repo-gated actors have no `gh` token to curl the release asset, so
# set LBABUS_LOCAL_BINARY=/path to install from a pre-staged binary (host-downloaded once, then
# vagrant-uploaded) with NO network — still version-gated identically.
#
# Verified: the self-contained binary runs `lbabus version` -> the pinned version with NO
# DOTNET_ROLL_FORWARD (unlike the dev-host dotnet global tool).
set -euo pipefail

log() { echo "[install-lbabus] $*"; }

LBABUS_VERSION="${LBABUS_VERSION:-0.10.0}"
REPO="${LBABUS_REPO:-LabVIEW-Community-CI-CD/labview-benchmark-actor}"
DEST="${LBABUS_DEST:-/usr/local/bin/lbabus}"
LOCAL_BINARY="${LBABUS_LOCAL_BINARY:-}"
ASSET="lbabus-${LBABUS_VERSION}-linux-x64"
URL="https://github.com/${REPO}/releases/download/collab-cli-v${LBABUS_VERSION}/${ASSET}"

destdir="$(dirname "$DEST")"
[ -d "$destdir" ] || { echo "[abort] $destdir does not exist." >&2; exit 1; }
[ -w "$destdir" ] || { echo "[abort] $destdir not writable — run as root (sudo ./install-lbabus.sh)." >&2; exit 1; }

# Idempotent: skip if the pinned version is already installed.
if [ -x "$DEST" ] && [ "$("$DEST" version 2>/dev/null | head -n1)" = "$LBABUS_VERSION" ]; then
  log "lbabus $LBABUS_VERSION already installed at $DEST — nothing to do."
  exit 0
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if [ -n "$LOCAL_BINARY" ]; then
  # Token-less mesh-clone path: internal-repo-gated actors can't curl the release asset (no gh token), so
  # install from a pre-staged binary (host-downloaded once, then vagrant-uploaded). No network here; the
  # functional version gate below still runs, so a wrong/corrupt staged file fails closed just the same.
  [ -f "$LOCAL_BINARY" ] || { echo "[abort] LBABUS_LOCAL_BINARY=$LOCAL_BINARY not found." >&2; exit 1; }
  log "installing from pre-staged binary $LOCAL_BINARY (no download) ..."
  cp "$LOCAL_BINARY" "$tmp"
else
  command -v curl >/dev/null 2>&1 || { echo "[abort] curl required (or set LBABUS_LOCAL_BINARY to a pre-staged binary)." >&2; exit 1; }
  log "downloading $ASSET (self-contained; ~64 MB) from collab-cli-v${LBABUS_VERSION} ..."
  curl -fsSL "$URL" -o "$tmp"
fi
chmod +x "$tmp"

# Functional integrity gate: no separate checksum is published, so the binary MUST report the exact
# pinned version — a mismatch means a wrong/corrupt asset, so fail closed rather than install it.
got="$("$tmp" version 2>/dev/null | head -n1 || true)"
if [ "$got" != "$LBABUS_VERSION" ]; then
  echo "[abort] downloaded binary reports '$got', expected '$LBABUS_VERSION' — not installing." >&2
  exit 1
fi

install -m 0755 "$tmp" "$DEST"
log "installed lbabus $LBABUS_VERSION -> $DEST"
log "mesh actors can now run:  lbabus net beacon  /  lbabus net listen   (TCP 7420 / UDP 7421) — no dotnet runtime needed."
