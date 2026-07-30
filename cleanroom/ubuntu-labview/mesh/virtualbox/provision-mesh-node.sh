#!/usr/bin/env bash
# provision-mesh-node.sh — turn a from-source lbabus golden into an lbabus MESH node on a VirtualBox
# INTERNAL network (intnet). Run IN the guest as root. The node must ALREADY have lbabus build-from-source
# (cleanroom/ubuntu-labview/provision-lbabus-fromsource.sh) + the emit units; this adds only the mesh layer:
#   1. installs the shared mesh runtime (tools/collab-cli/ci/mesh-actor.sh) as /usr/local/bin/lba-mesh-actor.sh
#   2. installs the generic VirtualBox mesh unit (lba-mesh.service, EnvironmentFile-based)
#   3. writes THIS node's identity to /etc/lba-mesh-actor
#
# The mesh forms over lbabus net (TCP 7420 + UDP 7421 peer coverage -> "MESH OK (TCP+UDP)"); mesh-actor.sh
# then emits the boot-benchmark MESH-OK marker (ttyS0-guarded). Proven on a VBox 2-node intnet mesh
# (mesh forms in ~5s; a 4-milestone from-source boot capture yielded buildMs~4958ms + meshFormMs~4681ms).
#
# Per-node env (each clone differs ONLY here — that is the whole point of the EnvironmentFile design):
#   MESH_AGENT      distinct actor name, e.g. mesh-11              [required]
#   MESH_SELF_IP    this node's mesh IP, e.g. 192.168.56.11        [required]
#   MESH_PEER_IPS   comma list of the OTHER nodes' mesh IPs        [required]
#   MESH_IFACE      the intnet NIC (default enp0s8 = VBox nic2)
#   TCP_PORT/UDP_PORT (default 7420/7421)
#   MESH_ACTOR_SRC  path to the shared mesh-actor.sh (default: alongside this script's repo checkout)
#   UNIT_SRC        path to the generic lba-mesh.service (default: alongside this script)
set -euo pipefail
log() { echo "[mesh-node] $*"; }
[ "$(id -u)" = 0 ] || { echo "[abort] run as root" >&2; exit 1; }

: "${MESH_AGENT:?set MESH_AGENT (distinct actor name, e.g. mesh-11)}"
: "${MESH_SELF_IP:?set MESH_SELF_IP (this node's mesh IP)}"
: "${MESH_PEER_IPS:?set MESH_PEER_IPS (comma list of OTHER nodes' mesh IPs)}"
MESH_IFACE="${MESH_IFACE:-enp0s8}"
TCP_PORT="${TCP_PORT:-7420}"
UDP_PORT="${UDP_PORT:-7421}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_ACTOR_SRC="${MESH_ACTOR_SRC:-$here/../../../../tools/collab-cli/ci/mesh-actor.sh}"
UNIT_SRC="${UNIT_SRC:-$here/lba-mesh.service}"
[ -f "$MESH_ACTOR_SRC" ] || { echo "[abort] mesh-actor.sh not found at $MESH_ACTOR_SRC (set MESH_ACTOR_SRC)" >&2; exit 1; }
[ -f "$UNIT_SRC" ] || { echo "[abort] lba-mesh.service not found at $UNIT_SRC (set UNIT_SRC)" >&2; exit 1; }

# 1) shared mesh runtime (normalize any CRLF from a Windows checkout).
sed 's/\r$//' "$MESH_ACTOR_SRC" > /usr/local/bin/lba-mesh-actor.sh
chmod 0755 /usr/local/bin/lba-mesh-actor.sh

# 2) this node's identity (self is auto-filtered from peers by mesh-actor.sh via the actor name).
cat > /etc/lba-mesh-actor <<ENV
VIHS_COLLAB_AGENT=$MESH_AGENT
LBABUS=/usr/local/bin/lbabus
MESH_PEERS=$MESH_PEER_IPS
MESH_BIND=$MESH_SELF_IP
MESH_IFACE=$MESH_IFACE
TCP_PORT=$TCP_PORT
UDP_PORT=$UDP_PORT
ENV

# 3) the generic mesh unit.
install -m0644 "$UNIT_SRC" /etc/systemd/system/lba-mesh.service
systemctl daemon-reload
systemctl enable lba-mesh.service >/dev/null 2>&1 || true

log "DONE — node '$MESH_AGENT' at $MESH_SELF_IP (peers=$MESH_PEER_IPS iface=$MESH_IFACE tcp=$TCP_PORT udp=$UDP_PORT)."
log "     lba-mesh.service enabled; forms the mesh on next boot (After=lba-lbabus-build.service, Restart=always)."
