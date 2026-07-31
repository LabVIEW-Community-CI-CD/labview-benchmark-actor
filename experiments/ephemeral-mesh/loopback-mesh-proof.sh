#!/usr/bin/env bash
# loopback-mesh-proof.sh -- single-node lbabus net loopback proof (P1 of the canonical ephemeral mesh).
#
# Proves the lbabus TCP+UDP bus (labview-benchmark-actor/bus-msg@1, ADR-0003/0004) end-to-end on ONE node:
# the node sends to ITSELF over 127.0.0.1 and hears itself back over BOTH transports -> "MESH OK (loopback
# TCP+UDP)". No peer VM, no shared storage, no disk state -- comms-only and self-contained, so it is exactly
# the unit a throwaway clone can run and then be destroyed (golden -> clone -> run -> destroy, cattle-not-pets).
#
# It deliberately uses NON-STANDARD loopback ports (47420/47421) so it never collides with a running
# lba-mesh.service (7420/7421). Emits machine-readable `RESULT key=value` lines + captured transport logs
# for a receipt, and exits 0 iff BOTH transports were proven.
set -u

LBABUS="${LBABUS:-/usr/local/bin/lbabus}"
TCP_PORT="${TCP_PORT:-47420}"
UDP_PORT="${UDP_PORT:-47421}"
TIMEOUT_SEC="${TIMEOUT_SEC:-25}"
UDP_BEACONS="${UDP_BEACONS:-3}"

# The bus envelope stamps the SENDER identity from VIHS_COLLAB_AGENT; pin it so the loopback beacon we hear
# back attributes to a known actor (the golden's /etc/lba-mesh-actor sets this for the service, not our shell).
actor="${VIHS_COLLAB_AGENT:-$(hostname)}"
export VIHS_COLLAB_AGENT="$actor"

# Run the CLI: a framework .dll via `dotnet`; a self-contained single-file binary directly.
run_lbabus() { case "$LBABUS" in *.dll) dotnet "$LBABUS" "$@" ;; *) "$LBABUS" "$@" ;; esac; }

lbabus_version="$(run_lbabus --version 2>/dev/null | head -1)"
tcp_out="$(mktemp)"; udp_out="$(mktemp)"
echo "[$actor] loopback mesh proof: lbabus=$LBABUS ($lbabus_version) tcp=$TCP_PORT udp=$UDP_PORT"

# 1. background loopback listeners: expect exactly 1 (self) over each transport, hard --timeout so a partial
#    proof can never hang. --echo ACKs the reliable TCP frame; --count-distinct counts UDP presence by identity.
run_lbabus net listen --tcp "$TCP_PORT" --echo --count 1 --timeout "$TIMEOUT_SEC" > "$tcp_out" 2>/dev/null &
tcp_pid=$!
run_lbabus net listen --udp "$UDP_PORT" --count-distinct 1 --timeout "$TIMEOUT_SEC" > "$udp_out" 2>/dev/null &
udp_pid=$!

sleep 2   # let our own listeners bind before we send to them

# 2. TCP: send ONE reliable CLAIM frame to SELF over loopback, retrying past the listener-bind race.
run_lbabus net send --hosts 127.0.0.1 --tcp "$TCP_PORT" --type CLAIM --task mesh-loopback \
  --message "loopback hello from $actor" --await 2 --retries 10 --retry-ms 500 >/dev/null 2>&1 || true

# 3. UDP: beacon presence to SELF over loopback.
run_lbabus net beacon --hosts 127.0.0.1 --udp "$UDP_PORT" --count "$UDP_BEACONS" --interval 1 \
  --task mesh-loopback >/dev/null 2>&1 || true

# 4. wait for both listeners, then count what we heard over each transport.
wait "$tcp_pid" 2>/dev/null
wait "$udp_pid" 2>/dev/null

tcp_frames="$(grep -c '^TCP ' "$tcp_out" 2>/dev/null || true)"; [ -z "$tcp_frames" ] && tcp_frames=0
udp_distinct="$(grep '^UDP ' "$udp_out" 2>/dev/null \
  | sed -n 's/.*\][[:space:]]\+\([^[:space:]]\+\)[[:space:]]\+#[0-9].*/\1/p' \
  | sort -u | grep -c . || true)"; [ -z "$udp_distinct" ] && udp_distinct=0

echo "RESULT actor=$actor"
echo "RESULT lbabus_version=$lbabus_version"
echo "RESULT tcp_port=$TCP_PORT"
echo "RESULT udp_port=$UDP_PORT"
echo "RESULT tcp_frames=$tcp_frames"
echo "RESULT udp_distinct=$udp_distinct"
echo "--- BEGIN tcp_out ---"; cat "$tcp_out"; echo "--- END tcp_out ---"
echo "--- BEGIN udp_out ---"; cat "$udp_out"; echo "--- END udp_out ---"
rm -f "$tcp_out" "$udp_out"

if [ "$tcp_frames" -ge 1 ] && [ "$udp_distinct" -ge 1 ]; then
  echo "[$actor] MESH OK (loopback TCP+UDP)"
  echo "RESULT mesh_ok=true"
  exit 0
fi
echo "[$actor] MESH INCOMPLETE (loopback)"
echo "RESULT mesh_ok=false"
exit 1
