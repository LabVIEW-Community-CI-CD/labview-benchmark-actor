#!/usr/bin/env bash
# Per-actor workload for the isolated-actor lbabus TCP/UDP MESH test -- Linux parity of ci/mesh-actor.ps1.
#
# Each container runs ONE copy under a distinct actor identity (VIHS_COLLAB_AGENT), fully ISOLATED -- no
# shared volume, no shared store. Actors coordinate ONLY through collab-cli's TCP/UDP bus (`lbabus net`,
# ADR-0003/0004, the bus-msg@1 envelope), resolving each other by container name on a user-defined `bridge`
# network.
#
# Exercises BOTH lbabus net transports:
#   1. a background TCP listener collecting exactly (peers-1) reliable frames (--echo ACKs each sender) AND a
#      background UDP listener collecting presence beacons, both with a hard --timeout so a partial mesh
#      cannot hang;
#   2. sends one CLAIM frame to every OTHER actor over TCP (`lbabus net send`), retrying past the startup
#      race; then emits UDP presence beacons (`lbabus net beacon`) to every peer;
#   3. counts the DISTINCT peers it heard from over TCP (reliable frames) and over UDP (each beacon envelope
#      carries the sender's actor name, so the count is by IDENTITY -- robust to datagram loss and SNAT).
#
# Exit 0 iff it heard from EVERY other actor over BOTH TCP and UDP (its side of a full mesh); 1 otherwise.
set -u

LBABUS="${LBABUS:-/out/cli/lbabus.dll}"
PEERS="${MESH_PEERS:-${1:-}}"          # comma-separated actor hostnames (self is filtered out)
TCP_PORT="${TCP_PORT:-7420}"
UDP_PORT="${UDP_PORT:-7421}"
TIMEOUT_SEC="${TIMEOUT_SEC:-90}"
UDP_TIMEOUT_SEC="${UDP_TIMEOUT_SEC:-30}"
UDP_BEACONS="${UDP_BEACONS:-3}"
SEND_RETRIES="${SEND_RETRIES:-45}"
SEND_RETRY_MS="${SEND_RETRY_MS:-1000}"

actor="${VIHS_COLLAB_AGENT:-actor-$$}"

# split PEERS csv, trim, drop self.
others=""
IFS=',' read -ra _peers <<< "$PEERS"
for p in "${_peers[@]}"; do
  p="$(printf '%s' "$p" | tr -d '[:space:]')"
  if [ -n "$p" ] && [ "$p" != "$actor" ]; then others="$others $p"; fi
done
expected="$(printf '%s' "$others" | wc -w | tr -d ' ')"

tcp_out="$(mktemp)"; udp_out="$(mktemp)"
echo "[$actor] mesh start: expected=$expected tcp=$TCP_PORT udp=$UDP_PORT"

# 1a. background TCP listener: collect exactly $expected reliable frames, echo an ACK to each sender.
dotnet "$LBABUS" net listen --tcp "$TCP_PORT" --echo --count "$expected" --timeout "$TIMEOUT_SEC" > "$tcp_out" 2>/dev/null &
tcp_pid=$!
# 1b. background UDP listener: collect presence beacons until timeout (loss-safe; we count distinct senders).
dotnet "$LBABUS" net listen --udp "$UDP_PORT" --timeout "$UDP_TIMEOUT_SEC" > "$udp_out" 2>/dev/null &
udp_pid=$!

sleep 2   # let our own listeners bind before the peers start hammering them

# 2. TCP: send one CLAIM to every other actor, retrying until that peer's listener accepts the connection.
# A successful TCP send is also our barrier that the peer is alive (so its UDP listener is bound too).
send_retry_s="$(awk "BEGIN{printf \"%.3f\", $SEND_RETRY_MS/1000}")"
for p in $others; do
  ok=0; r=1
  while [ "$r" -le "$SEND_RETRIES" ] && [ "$ok" -eq 0 ]; do
    if dotnet "$LBABUS" net send --host "$p" --tcp "$TCP_PORT" --type CLAIM --task mesh --message "hello from $actor" --await 2 >/dev/null 2>&1; then
      ok=1
    else
      sleep "$send_retry_s"
    fi
    r=$((r + 1))
  done
  [ "$ok" -eq 0 ] && echo "[$actor] WARN could not reach $p over TCP after $SEND_RETRIES tries"
done

# 3. UDP: emit presence beacons to every peer. `net beacon --host` needs an IP (it does NOT resolve names),
# so resolve each peer's container name to its bridge IP first; every beacon envelope still carries THIS
# actor's identity, so a peer attributes it regardless of datagram loss or address translation.
for p in $others; do
  ip="$(getent hosts "$p" 2>/dev/null | awk '{print $1; exit}')"
  if [ -z "$ip" ]; then echo "[$actor] WARN could not resolve $p for UDP"; continue; fi
  dotnet "$LBABUS" net beacon --host "$ip" --udp "$UDP_PORT" --count "$UDP_BEACONS" --interval 1 --task mesh >/dev/null 2>&1
done

# 4. wait for both listeners, then count DISTINCT peers heard from over each transport.
wait "$tcp_pid" 2>/dev/null
wait "$udp_pid" 2>/dev/null

tcp_received="$(grep -c '^TCP ' "$tcp_out" 2>/dev/null || true)"; [ -z "$tcp_received" ] && tcp_received=0
# UDP line = "UDP <addr>  [<ts>] <senderId> #<seq> ..." -- pull <senderId>, count distinct non-self peers.
udp_distinct="$(grep '^UDP ' "$udp_out" 2>/dev/null \
  | sed -n 's/.*\][[:space:]]\+\([^[:space:]]\+\)[[:space:]]\+#[0-9].*/\1/p' \
  | grep -vx "$actor" | sort -u | grep -c . || true)"; [ -z "$udp_distinct" ] && udp_distinct=0

echo "[$actor] TCP heard from $tcp_received / $expected ; UDP heard from $udp_distinct / $expected"
if [ "$tcp_received" -ge "$expected" ] && [ "$udp_distinct" -ge "$expected" ]; then
  echo "[$actor] MESH OK (TCP+UDP)"; exit 0
fi
echo "[$actor] MESH INCOMPLETE"; exit 1
