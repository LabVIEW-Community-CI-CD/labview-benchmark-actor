#!/usr/bin/env bash
# Publish a SELF-CONTAINED, single-file lbabus so it runs in a BARE container with NO .NET runtime and NO
# downloads (WAN-free) -- the container mounts this binary and executes it directly. Mirrors the WIN plane's
# host-build + mount approach for the ollama-governed container coordinator (task cross-plane-ollama-bus).
#
# Usage: ./publish-lbabus.sh [rid]   (rid defaults to linux-x64; OUT env overrides the output dir)
set -uo pipefail
RID="${1:-linux-x64}"
OUT="${OUT:-$HOME/lba-net/publish}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

dotnet publish "$REPO/tools/collab-cli/LbaBus.csproj" -c Release -r "$RID" \
  --self-contained true -p:PublishSingleFile=true -o "$OUT"
echo "published self-contained lbabus ($RID) -> $OUT/lbabus"
