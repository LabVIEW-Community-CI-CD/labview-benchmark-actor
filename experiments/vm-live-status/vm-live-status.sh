#!/usr/bin/env bash
# Live golden-VM status monitor + idle-time capture (LBA-REQ-047, ADR-0023 Phase 1 -- live VM visibility).
#
# The human-assisted golden-VM workflow has long stretches where neither human nor agent can see what the VM
# is doing (LabVIEW sitting idle while VIPM silently waits to connect = "dead time"). This tool streams the
# VM's overall CPU busy% (plus LabVIEW cpu/mem + vipm/Xvfb presence) on a fixed cadence over the SSH bridge,
# so both human and agent always know where the VM stands, and can `capture` a series to feed the pure
# idle-time analysis (experiments/vm-live-status/vmStatusAnalysis.mjs, gated by vm-live-status-idle-analysis).
#
# NOT gated (needs a live VM + ssh + /proc). The gated proof is the committed timeline receipt + analyzer.
#
# Usage:
#   vm-live-status.sh stream                 # continuous human-readable live status (Ctrl-C to stop)
#   vm-live-status.sh capture [secs] [out]   # capture <secs> of NDJSON samples (default 40s) -> stdout/out
# Env (defaults target lba-golden over the bridge):
#   VM_SSH_KEY (~/.ssh/lba_scratch)  VM_SSH_PORT (2222)  VM_SSH_USER (actor)  VM_SSH_HOST (127.0.0.1)
#   SAMPLE_INTERVAL (2 seconds)      IDLE_CPU_THRESHOLD (5 %, used by the analyzer, echoed here)
set -euo pipefail

VM_SSH_KEY="${VM_SSH_KEY:-$HOME/.ssh/lba_scratch}"
VM_SSH_PORT="${VM_SSH_PORT:-2222}"
VM_SSH_USER="${VM_SSH_USER:-actor}"
VM_SSH_HOST="${VM_SSH_HOST:-127.0.0.1}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-2}"
SSHO=(-i "$VM_SSH_KEY" -p "$VM_SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=1000)

# The remote sampling loop (runs entirely on the VM, one ssh, one line per sample). Positional args:
#   $1 = sample count, $2 = interval seconds, $3 = mode (json|human). CPU busy% is derived from /proc/stat
#   deltas (busy = 1 - (idle+iowait)/total between two snapshots); the first snapshot warms the delta.
REMOTE_SCRIPT="$(cat <<'REMOTE'
count="$1"; interval="$2"; mode="$3"
snap() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
read pt pi < <(snap); sleep "$interval"
i=0
while [ "$i" -lt "$count" ]; do
  i=$((i+1))
  read tt ti < <(snap)
  dt=$((tt-pt)); di=$((ti-pi)); pt=$tt; pi=$ti
  cpu=$(awk -v d="$dt" -v x="$di" 'BEGIN{ if (d>0) printf "%.1f",100*(1-x/d); else print "0.0" }')
  lvcpu=$(ps -eo %cpu,comm --no-headers 2>/dev/null | awk 'tolower($2)~/labview/{s+=$1}END{printf "%.0f",s+0}')
  lvmem=$(ps -eo rss,comm --no-headers 2>/dev/null | awk 'tolower($2)~/labview/{s+=$1}END{printf "%d",(s+0)/1024}')
  vipm=$(pgrep -x vipm-desktop >/dev/null 2>&1 && echo up || echo -)
  xvfb=$(pgrep -x Xvfb >/dev/null 2>&1 && echo up || echo -)
  t=$((i*interval))
  if [ "$mode" = json ]; then
    printf '{"t":%d,"cpuPct":%s,"lvCpuPct":%s,"lvMemMb":%s,"vipm":"%s","xvfb":"%s"}\n' "$t" "$cpu" "$lvcpu" "$lvmem" "$vipm" "$xvfb"
  else
    st=WORKING; awk -v c="$cpu" 'BEGIN{ exit !(c+0 < 5) }' && st="idle?"
    printf '[t+%03ds] cpu=%5s%% lv_cpu=%3s%% lv_mem=%5sMB vipm=%s Xvfb=%s -> %s\n' "$t" "$cpu" "$lvcpu" "$lvmem" "$vipm" "$xvfb" "$st"
  fi
  [ "$i" -lt "$count" ] && sleep "$interval"
done
exit 0
REMOTE
)"

case "${1:-help}" in
  stream)
    echo "# live VM status ($VM_SSH_USER@$VM_SSH_HOST:$VM_SSH_PORT, every ${SAMPLE_INTERVAL}s) -- Ctrl-C to stop" >&2
    ssh "${SSHO[@]}" "$VM_SSH_USER@$VM_SSH_HOST" bash -s -- 1000000 "$SAMPLE_INTERVAL" human <<<"$REMOTE_SCRIPT"
    ;;
  capture)
    secs="${2:-40}"; out="${3:-}"
    count=$(( secs / SAMPLE_INTERVAL )); if [ "$count" -lt 1 ]; then count=1; fi
    body="$(ssh "${SSHO[@]}" "$VM_SSH_USER@$VM_SSH_HOST" bash -s -- "$count" "$SAMPLE_INTERVAL" json <<<"$REMOTE_SCRIPT")"
    if [ -n "$out" ]; then printf '%s\n' "$body" > "$out"; echo "wrote $count samples ($((count*SAMPLE_INTERVAL))s) to $out" >&2; else printf '%s\n' "$body"; fi
    ;;
  *)
    grep -E '^#( |!)' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
