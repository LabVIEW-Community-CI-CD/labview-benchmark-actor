#!/usr/bin/env bash
# bootstrap-validate.sh -- Actor Corroboration Grid codespace WITNESS bootstrap (Phase 1; ADR-0014 / ADR-0015).
#
# Builds lbabus from the checked-out source, self-certifies it with the SAME shared gate-suite the VM runs
# (cleanroom/ubuntu-labview/lba/gate-suite.sh -- kept byte-identical by the `cleanroom-gate-suite-shared-in-sync`
# gate), and emits gate-suite-receipt.json. This is the codespace WITNESS half of the machine-parity anchor:
# same source@commit + same gate-suite => the same lbabus.version / sourceCommit / verdict the VBox witness
# produces.
#
# Codespace-native: uses the container's .NET SDK + network (no vendored offline NuGet cache -- that is the VM's
# from-scratch, offline-first concern, not the codespace's). NOT a hosted-CI gate (it builds a self-contained
# binary + needs the .NET SDK); it runs at devcontainer postCreate and on demand.
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SRC="$REPO/tools/collab-cli"
GATE_SUITE="$REPO/cleanroom/ubuntu-labview/lba/gate-suite.sh"
LBA_DIR="${LBA_DIR:-$HOME/.lba}"
DEST="$LBA_DIR/lbabus"
RID="${LBABUS_RID:-linux-x64}"

log() { echo "[bootstrap-validate] $*"; }

[ -f "$SRC/LbaBus.csproj" ] || { echo "[abort] no $SRC/LbaBus.csproj -- run from a full checkout" >&2; exit 2; }
[ -f "$GATE_SUITE" ] || { echo "[abort] missing shared gate-suite $GATE_SUITE" >&2; exit 2; }
command -v dotnet >/dev/null 2>&1 || { echo "[abort] no dotnet SDK on PATH" >&2; exit 2; }
mkdir -p "$LBA_DIR"

log "repo=$REPO  dotnet=$(dotnet --version)"
log "building lbabus from $SRC (self-contained single-file, $RID) ..."
rm -rf "$LBA_DIR/pub"
dotnet publish "$SRC/LbaBus.csproj" -c Release -r "$RID" --self-contained \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$LBA_DIR/pub" >/dev/null
install -m0755 "$LBA_DIR/pub/lbabus" "$DEST"
log "built $("$DEST" version | head -n1)"

# Source provenance the gate-suite receipt records (the VM path reads the same two files).
git -C "$REPO" rev-parse HEAD > "$LBA_DIR/SOURCE_COMMIT"
printf '%s' "${LBA_ROLE:-codespace}" > "$LBA_DIR/SOURCE_ROLE"

log "running the shared gate-suite (byte-identical to the VM's) ..."
set +e
LBABUS="$DEST" LBA_DIR="$LBA_DIR" bash "$GATE_SUITE"
rc=$?
set -e

RECEIPT="$LBA_DIR/gate-suite-receipt.json"
log "receipt -> $RECEIPT (gate-suite exit $rc)"
cat "$RECEIPT"
exit "$rc"
