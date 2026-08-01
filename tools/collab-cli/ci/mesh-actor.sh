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

# --- Vagrant host-only mesh parity (all opt-in; the Docker-CI defaults below are unchanged) ---
MESH_BIND="${MESH_BIND:-}"             # 0.11.0 `net --bind <ip>`: pin the SOURCE NIC (the host-only 192.168.56.x)
                                       # so beacons egress the mesh regardless of the NAT default route. Unset => auto.
MESH_OBSERVERS="${MESH_OBSERVERS:-}"   # extra comma-separated beacon TARGETS (e.g. the host observer 192.168.56.1)
                                       # that RECEIVE presence but are NOT counted as required mesh peers.

# --- Node type (source|sink|both): a source only EMITS, a sink only COLLECTS, both is the symmetric peer.
# Default = both (today's behavior). Orthogonal to the mesh-actors.csv lifecycle role (golden|mesh). Fail
# closed on an unknown type. (docs/proposals/mesh-node-types.md)
NODE_TYPE="$(printf '%s' "${NODE_TYPE:-both}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$NODE_TYPE" in
  source|sink|both) ;;
  *) echo "ERROR unknown NODE_TYPE='$NODE_TYPE' (expected source|sink|both)" >&2; exit 2 ;;
esac
case "$NODE_TYPE" in sink|both) is_listener=1 ;; *) is_listener=0 ;; esac
case "$NODE_TYPE" in source|both) is_emitter=1 ;; *) is_emitter=0 ;; esac

# Run the CLI: a framework .dll (Docker-CI /out/cli/lbabus.dll) via `dotnet`; a self-contained single-file
# binary (the Vagrant actors' /usr/local/bin/lbabus) directly.
run_lbabus() {
  case "$LBABUS" in
    *.dll) dotnet "$LBABUS" "$@" ;;
    *)     "$LBABUS" "$@" ;;
  esac
}

bind_arg=""
[ -n "$MESH_BIND" ] && bind_arg="--bind $MESH_BIND"

actor="${VIHS_COLLAB_AGENT:-actor-$$}"

# --- Role brief (opt-in): the actor's name -> a more specific AGENTS.md ---------------------------------
# When a role is known, materialize the pinned base instructions PLUS the matching role overlay so this
# actor carries the specialized brief its commit named. The role comes from LBA_AGENTS_ROLE (the launcher
# passes it) or, failing that, the Actor:/Agent: trailer of the commit in LBA_AGENTS_REPO
# (`lbabus agents --role-from-commit`). Best-effort: a missing lbabus/role/overlay never perturbs the mesh.
if [ -n "${LBA_AGENTS_ROLE:-}${LBA_AGENTS_REPO:-}" ]; then
  _brief_out="${LBA_AGENTS_OUT:-AGENTS.md}"
  if [ -n "${LBA_AGENTS_ROLE:-}" ]; then
    run_lbabus agents --role "$LBA_AGENTS_ROLE" --out "$_brief_out" >/dev/null 2>&1 \
      && echo "[$actor] role brief: $_brief_out (role $LBA_AGENTS_ROLE)" || true
  else
    run_lbabus agents --role-from-commit --repo "$LBA_AGENTS_REPO" --out "$_brief_out" >/dev/null 2>&1 \
      && echo "[$actor] role brief: $_brief_out (from commit in $LBA_AGENTS_REPO)" || true
  fi
fi

# split PEERS csv, trim, drop self.
others=""
IFS=',' read -ra _peers <<< "$PEERS"
for p in "${_peers[@]}"; do
  p="$(printf '%s' "$p" | tr -d '[:space:]')"
  if [ -n "$p" ] && [ "$p" != "$actor" ]; then others="$others $p"; fi
done
expected="$(printf '%s' "$others" | wc -w | tr -d ' ')"
peer_csv="$(echo $others | tr ' ' ',')"   # comma-joined peer list for the single --hosts fan-out (self already dropped)

tcp_out="$(mktemp)"; udp_out="$(mktemp)"
echo "[$actor] mesh start: expected=$expected tcp=$TCP_PORT udp=$UDP_PORT"

# 1. background listeners (sink|both only): TCP collects exactly $expected reliable frames (echoing an ACK to
# each sender); UDP collects presence beacons, exiting as soon as it has heard EVERY distinct peer
# (--count-distinct) or the timeout fires. A pure source starts NO listeners (node types are enforced).
if [ "$is_listener" = 1 ]; then
  run_lbabus net listen --tcp "$TCP_PORT" --echo --count "$expected" --timeout "$TIMEOUT_SEC" > "$tcp_out" 2>/dev/null &
  tcp_pid=$!
  run_lbabus net listen --udp "$UDP_PORT" --count-distinct "$expected" --timeout "$UDP_TIMEOUT_SEC" > "$udp_out" 2>/dev/null &
  udp_pid=$!
fi

sleep 2   # let our own listeners bind before the peers start hammering them

# 2. TCP: ONE `lbabus net send` fans a CLAIM out to EVERY other actor via --hosts, retrying each peer until
# its listener accepts (startup race). One process per actor -- not one per peer -- keeps the mesh at O(N)
# total dotnet launches instead of O(N^2), so the proof measures the lbabus net transport rather than dotnet
# process-startup contention. A clean exit is also our barrier that every peer is alive.
if [ "$is_emitter" = 1 ] && ! run_lbabus net send --hosts "$peer_csv" --tcp "$TCP_PORT" --type CLAIM --task mesh \
    --message "hello from $actor" --await 2 --retries "$SEND_RETRIES" --retry-ms "$SEND_RETRY_MS" >/dev/null 2>&1; then
  echo "[$actor] WARN one or more TCP peers unreachable after $SEND_RETRIES tries"
fi

# 3. UDP: ONE `lbabus net beacon` fans presence beacons out to EVERY peer via --hosts (the CLI resolves each
# container name to its bridge IPv4 itself, so no pre-resolve is needed). Every envelope carries THIS actor's
# identity, so a peer attributes each beacon regardless of datagram loss or address translation. On the Vagrant
# mesh we also beacon to MESH_OBSERVERS (the host .1 monitor) so the read-only host viewer sees presence, and
# --bind pins the host-only source NIC; observers are extra TARGETS, never required peers.
beacon_hosts="$peer_csv"
[ -n "$MESH_OBSERVERS" ] && beacon_hosts="${beacon_hosts:+$beacon_hosts,}$MESH_OBSERVERS"
[ "$is_emitter" = 1 ] && run_lbabus net beacon --hosts "$beacon_hosts" --udp "$UDP_PORT" $bind_arg --count "$UDP_BEACONS" --interval 1 --task mesh >/dev/null 2>&1 || true

# 4. verdict. A sink|both waits for its listeners and counts DISTINCT peers heard over each transport; a pure
# source has nothing to hear -- its success is that it fanned its stream out to every peer.
if [ "$is_listener" = 1 ]; then
  wait "$tcp_pid" 2>/dev/null
  wait "$udp_pid" 2>/dev/null

  tcp_received="$(grep -c '^TCP ' "$tcp_out" 2>/dev/null || true)"; [ -z "$tcp_received" ] && tcp_received=0
  # UDP line = "UDP <addr>  [<ts>] <senderId> #<seq> ..." -- pull <senderId>, count distinct non-self peers.
  udp_distinct="$(grep '^UDP ' "$udp_out" 2>/dev/null \
    | sed -n 's/.*\][[:space:]]\+\([^[:space:]]\+\)[[:space:]]\+#[0-9].*/\1/p' \
    | grep -vx "$actor" | sort -u | grep -c . || true)"; [ -z "$udp_distinct" ] && udp_distinct=0

  echo "[$actor] TCP heard from $tcp_received / $expected ; UDP heard from $udp_distinct / $expected"
  if [ "$tcp_received" -ge "$expected" ] && [ "$udp_distinct" -ge "$expected" ]; then
    echo "[$actor] MESH OK (TCP+UDP)"
    # boot-benchmark MESH-OK milestone (co-owned drop-in): emit ONLY when a serial sink is attached
    # ([ -w /dev/ttyS0 ]) so this is a silent no-op off-bench (Docker-CI + normal mesh write nothing). The
    # shared emit helper writes the serial frame-pin + a journald lbabench line; best-effort, never fatal.
    _emit=; for _p in /usr/local/bin/emit-boot-marker.sh /opt/lba/emit-boot-marker.sh; do [ -x "$_p" ] && { _emit="$_p"; break; }; done
    [ -w /dev/ttyS0 ] && [ -n "$_emit" ] && "$_emit" MESH-OK >/dev/null 2>&1 || true
    exit 0
  fi
  echo "[$actor] MESH INCOMPLETE"; exit 1
else
  echo "[$actor] SOURCE emitted to $expected peer(s)"
  echo "[$actor] MESH OK (source)"
  exit 0
fi
