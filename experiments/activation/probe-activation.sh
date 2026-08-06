#!/usr/bin/env bash
# LabVIEW activation-confirmation probe (LBA-REQ-038, realizes ADR-0023 Phase 1). Runs a headless
# KNOWN-ANSWER probe VI via `LabVIEWCLI -OperationName RunVI` and captures a raw result the host can turn
# into an `activation-receipt@1` (buildActivationReceipt.mjs). Success = LabVIEW executed the VI and
# returned the expected sum => the install is ACTIVATED and operational (a functional proof, more robust
# than parsing license files -- see ADR-0023 / docs/roadmap.md).
#
# The probe VI is NI's shipped, canonical `AddTwoNumbers.vi` (part of the LabVIEWCLI install, present on
# every properly-installed Ubuntu+LabVIEW golden box), so no binary VI is committed and the known answer is
# deterministic: inputs A B -> A+B.
#
# Usage (on the host or guest):  bash probe-activation.sh [A=20] [B=22] [OUT=/tmp/lba-activation-capture.json]
# Self-contained: explicit PATH + absolute tool paths so it survives a detached / non-login shell.
set -u
export PATH=/usr/local/bin:/usr/local/natinst/share/nilvcli:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}

A="${1:-20}"
B="${2:-22}"
OUT="${3:-/tmp/lba-activation-capture.json}"
EXPECTED=$((A + B))
VIP=/usr/local/natinst/share/nilvcli/Examples/AddTwoNumbers/AddTwoNumbers.vi
LVP=/usr/local/natinst/LabVIEW-2026-64/labview
LVCLI=/usr/local/bin/LabVIEWCLI
PROBE_OUT=/tmp/lba-activation-probe.out

emit_capture() {
  python3 - "$A" "$B" "$EXPECTED" "$1" "$2" "$VIP" "$LVP" "$PROBE_OUT" "$OUT" <<'PY'
import json
import os
import platform
import socket
import sys

a, b, expected, exit_code, wall_ms, probe_vi, labview_path, probe_out, destination = sys.argv[1:]
try:
    with open(probe_out, encoding="utf-8", errors="replace") as handle:
        output = handle.read()
except FileNotFoundError:
    output = ""

record = {
    "schema": "labview-benchmark-actor/activation-capture@1",
    "probeVi": probe_vi,
    "labviewPath": labview_path,
    "inputs": [int(a), int(b)],
    "expectedOutput": int(expected),
    "exitCode": int(exit_code),
    "wallMs": int(wall_ms),
    "output": output,
    "host": {"os": platform.system().lower(), "hostname": socket.gethostname()},
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY
}

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'python3 is required to write the activation capture' > "$PROBE_OUT"
  echo "activation capture unavailable: python3 is missing" >&2
  exit 127
fi

# Headless display :99 (isolated from any gdm :0 session); start only if not already up. LabVIEW SEGFAULTS
# on a half-initialized display, so poll xdpyinfo (bounded ~30s) + a 1s settle before launching.
if ! command -v xvfb-run >/dev/null 2>&1; then
  printf '%s\n' 'xvfb-run is required for the headless activation probe; run provision-guest.sh first.' > "$PROBE_OUT"
  emit_capture 127 0
  echo "activation capture -> $OUT (exit=127; missing headless display prerequisite)" >&2
  cat "$PROBE_OUT"
  exit 127
fi

run_probe() {
  xvfb-run -a timeout 240 "$LVCLI" -LabVIEWPath "$LVP" -PortNumber 3363 \
    -OperationName RunVI -VIPath "$VIP" "$A" "$B"
}

t0=$(date +%s%N)
run_probe > "$PROBE_OUT" 2>&1
rc=$?
t1=$(date +%s%N)
wall=$(( (t1 - t0) / 1000000 ))

emit_capture "$rc" "$wall"
echo "activation capture -> $OUT (exit=$rc wall=${wall}ms expected=$EXPECTED)"
cat "$PROBE_OUT"
exit "$rc"
