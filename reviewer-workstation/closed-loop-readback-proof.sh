#!/usr/bin/env bash
# closed-loop-readback-proof.sh -- proves the host<->VM-agent read-back loop over `lbabus net` TCP WITHOUT a
# live Copilot drive. Two loopback cases exercise await-agent-reply.mjs (the new host-side structured consumer):
#
#   PASS         a simulated VM-agent DONE whose task id MATCHES -> the awaiter correlates + exits 0 (loop closed).
#   FAIL-CLOSED  a DONE whose task id is WRONG -> the awaiter does NOT match + exits 1 (correlation guard holds).
#
# The NETWORK path (guest->host) is already proven in experiments/provider-delegation/vm-run-evidence.json
# (a host listener at 10.0.2.2:7420 received a DONE from inside the VM); this proof adds the NEW correlation +
# structured-await logic that closes the loop. No GitHub Discussion is involved -- TCP only.
#
# Emits RESULT key=value lines + a receipt; exits 0 iff BOTH cases behave.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
export DOTNET_ROLL_FORWARD="${DOTNET_ROLL_FORWARD:-Major}"
export VIHS_COLLAB_AGENT="${VIHS_COLLAB_AGENT:-vm-actor}"
: "${LBABUS:=$repo/tools/collab-cli/bin/Release/net8.0/lbabus.dll}"
export LBABUS
run_lbabus() { case "$LBABUS" in *.dll) dotnet "$LBABUS" "$@" ;; *) "$LBABUS" "$@" ;; esac; }

PORT="${PORT:-47420}"   # non-standard loopback port, never collides with a running lba-mesh.service (7420)
out="${OUT:-/tmp/closed-loop-proof}"; mkdir -p "$out"
echo "[proof] lbabus=$LBABUS port=$PORT out=$out"

# --- case 1: matching task id -> the loop closes ---------------------------------------------------
task="loop-proof-$(date +%s)"
node "$here/await-agent-reply.mjs" --task "$task" --tcp "$PORT" --timeout 15 --out "$out/pass-receipt.json" \
  > "$out/pass-reply.json" 2> "$out/pass.log" &
aw=$!
sleep 2
run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --type DONE --task "$task" \
  --message "release candidate staged; visual verdict PASS signed" --await 2 --retries 10 --retry-ms 300 \
  > "$out/pass-send.log" 2>&1 || true
if wait "$aw"; then pass_ok=true; else pass_ok=false; fi

# --- case 2: WRONG task id -> fail-closed (no correlation) ------------------------------------------
task2="loop-proof-$(date +%s)-b"
node "$here/await-agent-reply.mjs" --task "$task2" --tcp "$PORT" --timeout 12 --out "$out/negative-receipt.json" \
  > "$out/neg-reply.json" 2> "$out/neg.log" &
aw2=$!
sleep 2
run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --type DONE --task "WRONG-$task2" \
  --message "different task -- must NOT correlate" --await 2 --retries 10 --retry-ms 300 \
  > "$out/neg-send.log" 2>&1 || true
if wait "$aw2"; then neg_matched=true; else neg_matched=false; fi   # we WANT no match here

# --- case 3: SEMANTIC verdict type over net (option A / ADR-0039) -> RESOLVED correlates -----------
vtask="ext-release-0.5.0"
node "$here/await-agent-reply.mjs" --task "$vtask" --type RESOLVED --tcp "$PORT" --timeout 12 --out "$out/verdict-receipt.json" \
  > "$out/verdict-reply.json" 2> "$out/verdict.log" &
aw3=$!
sleep 2
run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --type RESOLVED --task "$vtask" \
  --message "RESOLVED: PASS for ext 0.5.0 by reviewer@vi-tech.nl (signed)" --await 2 --retries 10 --retry-ms 300 \
  > "$out/verdict-send.log" 2>&1 || true
if wait "$aw3"; then verdict_ok=true; else verdict_ok=false; fi

result_ok=false
[[ "$pass_ok" == true && "$neg_matched" == false && "$verdict_ok" == true ]] && result_ok=true

cat > "$out/proof-receipt.json" <<JSON
{
  "schema": "labview-benchmark-actor/closed-loop-readback-proof@1",
  "transport": "lbabus net -- bus-msg@1, ADR-0003/0004 (loopback 127.0.0.1 TCP ${PORT})",
  "lbabus": "${LBABUS}",
  "networkPathProvenBy": "experiments/provider-delegation/vm-run-evidence.json (host 10.0.2.2:7420 received DONE from the VM)",
  "cases": {
    "matchingTaskClosesLoop": ${pass_ok},
    "wrongTaskFailsClosed": $([[ "$neg_matched" == false ]] && echo true || echo false),
    "semanticVerdictTypeOverNet": ${verdict_ok}
  },
  "passReceipt": "pass-receipt.json",
  "negativeReceipt": "negative-receipt.json",
  "verdictReceipt": "verdict-receipt.json",
  "ok": ${result_ok},
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "RESULT pass_ok=$pass_ok"
echo "RESULT wrong_task_failed_closed=$([[ "$neg_matched" == false ]] && echo true || echo false)"
echo "RESULT semantic_verdict_type_over_net=$verdict_ok"
echo "RESULT ok=$result_ok"
echo "--- pass reply (VM agent -> host) ---"; cat "$out/pass-reply.json" 2>/dev/null || true
echo "--- proof receipt ---"; cat "$out/proof-receipt.json"

if [[ "$result_ok" == true ]]; then echo "[proof] CLOSED-LOOP READ-BACK OK (TCP, no GitHub Discussion)"; exit 0; fi
echo "[proof] CLOSED-LOOP READ-BACK INCOMPLETE" >&2; exit 1
