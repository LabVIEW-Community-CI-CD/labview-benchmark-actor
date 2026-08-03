#!/usr/bin/env bash
# net-coordination-log-proof.sh -- proves the LIVE-ONLY net coordination model (LBA-REQ-060, ADR-0040): a
# per-actor `net listen --log` receive-log + a `net poll` read side, replacing the GitHub-Discussion post/poll.
#
# Loopback (no VM, no github.com): a listener records 2 frames to a local JSONL receive-log; `net poll` reads
# them back and filters by --type; `net poll` with NO log arg FAILS CLOSED. This is the read side of moving
# coordination off GitHub Discussions onto TCP (the send side is the existing `net send`). Emits RESULT lines +
# a receipt; exits 0 iff every case behaves.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export DOTNET_ROLL_FORWARD="${DOTNET_ROLL_FORWARD:-Major}"
export VIHS_COLLAB_AGENT="${VIHS_COLLAB_AGENT:-win-plane}"
: "${LBABUS:=$repo/tools/collab-cli/bin/Release/net8.0/lbabus.dll}"
export LBABUS
run_lbabus() { case "$LBABUS" in *.dll) dotnet "$LBABUS" "$@" ;; *) "$LBABUS" "$@" ;; esac; }

PORT="${PORT:-47430}"   # non-standard loopback port, never collides with a running lba-mesh.service (7420)
out="${OUT:-/tmp/net-coordination-proof}"; mkdir -p "$out"
log="$out/bus-log.jsonl"; rm -f "$log"
echo "[proof] lbabus=$LBABUS port=$PORT log=$log"

# 1) a `net listen --log` daemon records what it hears to a local JSONL receive-log (per-actor, no central store).
run_lbabus net listen --tcp "$PORT" --log "$log" --count 2 --timeout 15 > "$out/listen.log" 2>&1 &
lp=$!
sleep 2
# 2) two posts over net: a coordination NOTE + a semantic verdict RESOLVED (the send side already exists).
run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --type NOTE --task coord \
  --message "hello from win plane" --await 2 --retries 10 --retry-ms 300 > /dev/null 2>&1 || true
run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --type RESOLVED --task ext-release-0.5.0 \
  --message "PASS for ext 0.5.0" --await 2 --retries 10 --retry-ms 300 > /dev/null 2>&1 || true
wait "$lp" 2>/dev/null

# 3) `net poll` reads the local receive-log back (all, then filtered by --type).
poll_all="$(run_lbabus net poll --log "$log" --tail 10 2>/dev/null)"
poll_note="$(run_lbabus net poll --log "$log" --type NOTE 2>/dev/null)"
poll_resolved="$(run_lbabus net poll --log "$log" --type RESOLVED 2>/dev/null)"
# 4) graceful no-op: `net poll` with no --log and no env exits 0 (live-only default, ADR-0045).
( unset VIHS_COLLAB_NET_LOG; run_lbabus net poll > /dev/null 2>&1 ); noarg_rc=$?

logged=$(grep -c . "$log" 2>/dev/null || echo 0)
all_count=$(printf '%s\n' "$poll_all" | grep -c 'task:' || true)
roundtrip_ok=false; [[ "$logged" == 2 && "$all_count" == 2 ]] && roundtrip_ok=true
note_ok=false; { echo "$poll_note" | grep -q 'NOTE task:coord' && ! echo "$poll_note" | grep -q 'RESOLVED'; } && note_ok=true
resolved_ok=false; echo "$poll_resolved" | grep -q 'RESOLVED task:ext-release-0.5.0' && resolved_ok=true
graceful_ok=false; [[ "$noarg_rc" == 0 ]] && graceful_ok=true

result_ok=false
[[ "$roundtrip_ok" == true && "$note_ok" == true && "$resolved_ok" == true && "$graceful_ok" == true ]] && result_ok=true

cat > "$out/net-coordination-log-receipt.json" <<JSON
{
  "schema": "labview-benchmark-actor/net-coordination-log-proof@1",
  "requirement": "LBA-REQ-060",
  "adr": "ADR-0040",
  "model": "live-only over lbabus net TCP -- per-actor local receive-log, no central/async store (no GitHub Discussion)",
  "transport": "lbabus net -- bus-msg@1, ADR-0003/0004 (loopback 127.0.0.1 TCP ${PORT})",
  "cases": {
    "postToLogToPollRoundTrip": ${roundtrip_ok},
    "typeFilterNote": ${note_ok},
    "typeFilterResolved": ${resolved_ok},
    "pollWithoutLogGraceful": ${graceful_ok}
  },
  "framesLogged": ${logged},
  "ok": ${result_ok},
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "RESULT roundtrip_ok=$roundtrip_ok"
echo "RESULT type_filter_note=$note_ok"
echo "RESULT type_filter_resolved=$resolved_ok"
echo "RESULT poll_without_log_graceful=$graceful_ok"
echo "RESULT ok=$result_ok"
echo "--- net poll (all) ---"; printf '%s\n' "$poll_all"
echo "--- receipt ---"; cat "$out/net-coordination-log-receipt.json"

if [[ "$result_ok" == true ]]; then echo "[proof] NET COORDINATION LOG OK (live-only TCP, no GitHub Discussion)"; exit 0; fi
echo "[proof] NET COORDINATION LOG INCOMPLETE" >&2; exit 1
