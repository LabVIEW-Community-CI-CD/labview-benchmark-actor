#!/usr/bin/env bash
# Isolated-actor lbabus TCP/UDP MESH test (Linux host, Linux-container engine) -- parity of ci/mesh-windows.ps1.
#
# Launches N containers from the lbabus Linux verification image on a user-defined `bridge` network, each a
# DISTINCT named actor (VIHS_COLLAB_AGENT), fully ISOLATED -- no shared volume, no shared store. The actors
# coordinate ONLY through collab-cli's TCP/UDP bus (`lbabus net`, see ci/mesh-actor.sh), resolving each other
# by container name. Each actor must hear from EVERY other actor over BOTH TCP (reliable frames) and UDP
# (presence beacons); when every actor exits 0, a complete TCP+UDP mesh formed.
#
# Exits 0 on a full mesh (all actors 0); 1 if any actor did not complete. Self-cleaning.
#
#   docker build -f tools/collab-cli/ci/Dockerfile.linux --target mesh -t lbabus-linux-verify:mesh tools/collab-cli
#   bash tools/collab-cli/ci/mesh-linux.sh --actors 3
#   bash tools/collab-cli/ci/mesh-linux.sh --actors 128   # scale headroom on a big-RAM Linux host
set -u

IMAGE="lbabus-linux-verify:mesh"
ACTORS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --actors) ACTORS="$2"; shift 2 ;;
    *) echo "mesh-linux: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

run="lbabus-mesh-$$-${RANDOM}"
net="${run}-net"
names=""
for i in $(seq 1 "$ACTORS"); do names="$names ${run}-actor-${i}"; done
peers="$(printf '%s' "$names" | xargs | tr ' ' ',')"

# Scale the per-actor timeouts with N: a large mesh takes longer to fully form (every actor opens N-1 TCP
# connections + emits N-1 beacon streams) and containers launch sequentially, so early actors retry longer
# while late actors' listeners come up.
tcp_timeout=$(( 60 + ACTORS * 3 ))
# UDP presence uses the SAME budget as TCP: at scale the mesh takes ~tcp_timeout to fully form, so a short
# UDP window expired before late beacons arrived (the old `30 + N` dropped UDP at 64). The listener's
# --count-distinct early-exit means this longer ceiling never slows a mesh that HAS formed.
udp_timeout=$tcp_timeout

echo "== lbabus TCP+UDP mesh: $ACTORS isolated actors (image $IMAGE, network $net) =="
# Linux containers: the default `bridge` driver exists (Windows needs `-d nat`); a user-defined bridge
# network gives container-name DNS so actors resolve peers by name.
docker network create "$net" >/dev/null

cleanup() {
  for n in $names; do docker rm -f "$n" >/dev/null 2>&1; done
  docker network rm "$net" >/dev/null 2>&1
}
trap cleanup EXIT

# Launch each isolated actor on the shared network; they reach each other only by name over `lbabus net`.
for n in $names; do
  docker run -d --name "$n" --hostname "$n" --network "$net" \
    -e "VIHS_COLLAB_AGENT=$n" -e "MESH_PEERS=$peers" \
    -e "TIMEOUT_SEC=$tcp_timeout" -e "UDP_TIMEOUT_SEC=$udp_timeout" -e "SEND_RETRIES=90" \
    -e "UDP_BEACONS=1" \
    "$IMAGE" >/dev/null
done

# Wait for every actor to exit (docker wait blocks and prints the exit code).
for n in $names; do docker wait "$n" >/dev/null 2>&1; done

echo
ok_count=0
for n in $names; do
  code="$(docker inspect -f '{{.State.ExitCode}}' "$n" 2>/dev/null)"
  if [ "$code" = "0" ]; then
    ok_count=$((ok_count + 1))
  else
    echo "  FAILED $n (exit ${code:-?}):"
    docker logs "$n" 2>&1 | tail -n 6 | sed 's/^/      /'
  fi
done

echo "mesh result: $ok_count / $ACTORS actors formed the full TCP+UDP mesh"
if [ "$ok_count" -eq "$ACTORS" ]; then
  echo "PASS  full TCP+UDP mesh: all $ACTORS isolated actors heard from every peer over TCP and UDP (lbabus net, no shared state)"
  exit 0
fi
echo "FAIL  mesh incomplete: $((ACTORS - ok_count)) / $ACTORS actors did not complete"
exit 1
