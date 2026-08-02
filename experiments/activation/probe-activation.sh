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

# Headless display :99 (isolated from any gdm :0 session); start only if not already up. LabVIEW SEGFAULTS
# on a half-initialized display, so poll xdpyinfo (bounded ~30s) + a 1s settle before launching.
if ! pgrep -f 'Xvfb :99' >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 &
fi
export DISPLAY=:99
for _ in $(seq 1 60); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.5; done
sleep 1

t0=$(date +%s%N)
timeout 240 "$LVCLI" -LabVIEWPath "$LVP" -OperationName RunVI -VIPath "$VIP" "$A" "$B" > /tmp/lba-activation-probe.out 2>&1
rc=$?
t1=$(date +%s%N)
wall=$(( (t1 - t0) / 1000000 ))
OUTTEXT=$(cat /tmp/lba-activation-probe.out)

# Emit a raw capture (JSON) the host builder consumes. jq-free: escape the output text with node (which
# also re-parses OUTTEXT). The destination path is passed as the last argv so it survives a non-exported var.
node -e '
  const [a,b,expected,rc,wall,viPath,lvPath,out,dest] = process.argv.slice(1);
  const rec = {
    schema: "labview-benchmark-actor/activation-capture@1",
    probeVi: viPath, labviewPath: lvPath,
    inputs: [Number(a), Number(b)], expectedOutput: Number(expected),
    exitCode: Number(rc), wallMs: Number(wall), output: out,
    host: { os: process.platform, hostname: require("os").hostname() },
  };
  require("fs").writeFileSync(dest, JSON.stringify(rec, null, 2) + "\n");
' "$A" "$B" "$EXPECTED" "$rc" "$wall" "$VIP" "$LVP" "$OUTTEXT" "$OUT"
echo "activation capture -> $OUT (exit=$rc wall=${wall}ms expected=$EXPECTED)"
cat /tmp/lba-activation-probe.out
