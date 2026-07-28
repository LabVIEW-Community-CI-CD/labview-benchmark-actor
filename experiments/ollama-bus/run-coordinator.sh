#!/usr/bin/env bash
# Start the CONTAINER COORDINATOR: a bare container that mounts the host-built self-contained lbabus and runs
# `lbabus net listen` (WAN-free -- the container downloads/builds nothing). The host lbabus (governed by ollama)
# coordinates it via `lbabus net send` -- see gov-send.sh. Task cross-plane-ollama-bus.
#
# Usage: ./run-coordinator.sh [port] [count]   (count 0 = listen forever; env: IMAGE, LBABUS_DIR, NAME)
set -uo pipefail
PORT="${1:-7420}"
COUNT="${2:-0}"
IMAGE="${IMAGE:-ubuntu:22.04}"
LBABUS_DIR="${LBABUS_DIR:-$HOME/lba-net/publish}"   # dir holding the self-contained lbabus (see publish-lbabus.sh)
NAME="${NAME:-lba-coord}"

if [ ! -x "$LBABUS_DIR/lbabus" ]; then
  echo "self-contained lbabus not found at $LBABUS_DIR/lbabus -- run ./publish-lbabus.sh first" >&2
  exit 2
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "[coordinator] $IMAGE (bare, no .NET) net listen --tcp $PORT --echo --count $COUNT (VIHS_COLLAB_AGENT=CONTAINER)"
exec docker run --rm --name "$NAME" -p "$PORT:$PORT" -v "$LBABUS_DIR:/lba:ro" \
  -e VIHS_COLLAB_AGENT=CONTAINER "$IMAGE" \
  /lba/lbabus net listen --tcp "$PORT" --echo --count "$COUNT"
