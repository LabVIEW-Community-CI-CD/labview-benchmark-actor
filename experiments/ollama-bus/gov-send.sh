#!/usr/bin/env bash
# OLLAMA-GOVERNED HOST GOVERNOR -> container coordinator over lbabus net (WAN-free). The host ollama (GPU)
# GENERATES each diagnostic line; the host lbabus SENDS it to the container coordinator (lbabus net listen),
# which prints + ACKs it. This is ollama's "diagnostics entrypoint": generate -> send -> the container prints.
# Task cross-plane-ollama-bus (mirrors the WIN plane).
#
# Usage: ./gov-send.sh [port]
#   env: LOOP (iterations, default 1), INTERVAL (seconds between, default 0), OLLAMA_MODEL (default llama3.1:8b),
#        OLLAMA_URL (default http://127.0.0.1:11434), HOST (default 127.0.0.1), LBABUS (self-contained binary).
set -uo pipefail
export VIHS_COLLAB_AGENT="${VIHS_COLLAB_AGENT:-LINUX-HOST}"
LBABUS="${LBABUS:-$HOME/lba-net/publish/lbabus}"
HOST="${HOST:-127.0.0.1}"
PORT="${1:-7420}"
MODEL="${OLLAMA_MODEL:-lba-coordinator}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
LOOP="${LOOP:-1}"
INTERVAL="${INTERVAL:-0}"

# The lba-coordinator model (durable lesson store) GOVERNS: emit one concise bus-aware coordination/diagnostic
# line, applying a banked lesson when relevant. Sanitized to a single safe line for the bus message.
gen_diag() {
  local resp
  resp=$(curl -s "$OLLAMA_URL/api/generate" -d "{\"model\":\"$MODEL\",\"prompt\":\"Govern the container coordinator: emit ONE concise ASCII line (max 100 chars, no quotes, no preamble) of operational diagnostics or coordination. Apply a banked lesson if relevant.\",\"stream\":false,\"options\":{\"num_ctx\":8192}}")
  printf '%s' "$resp" | jq -r '.response // empty' | tr '\n' ' ' | tr -cd '[:print:]' | sed 's/[`"]//g' | cut -c1-110
}

echo "[gov] HELLO -> $HOST:$PORT (VIHS_COLLAB_AGENT=$VIHS_COLLAB_AGENT)"
"$LBABUS" net send --host "$HOST" --tcp "$PORT" --type HELLO --task ollama-gov \
  --message "$VIHS_COLLAB_AGENT governor online (ollama-governed)" --await 3

for i in $(seq 1 "$LOOP"); do
  DIAG=$(gen_diag); [ -z "$DIAG" ] && DIAG="ollama-empty-fallback: coordinator health nominal"
  echo "[gov $i/$LOOP] $MODEL: $DIAG"
  "$LBABUS" net send --host "$HOST" --tcp "$PORT" --type PROGRESS --task ollama-gov --message "$DIAG" --await 4
  if [ "$i" -lt "$LOOP" ] && [ "$INTERVAL" -gt 0 ]; then sleep "$INTERVAL"; fi
done
echo "[gov] done ($LOOP diagnostic(s))"
