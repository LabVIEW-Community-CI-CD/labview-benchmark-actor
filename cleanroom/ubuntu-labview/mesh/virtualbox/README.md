# VirtualBox lbabus mesh (host-only via `intnet`)

The VirtualBox counterpart to the VMware mesh in [`../Vagrantfile`](../Vagrantfile). The mesh **runtime** is
shared verbatim ([`tools/collab-cli/ci/mesh-actor.sh`](../../../../tools/collab-cli/ci/mesh-actor.sh):
TCP 7420 + UDP 7421 peer coverage → `MESH OK (TCP+UDP)`, then the ttyS0-guarded MESH-OK emit); only the
**topology + networking** differ. This directory fills the documented gap (no VBox mesh path existed).

Proven: a 2-node VBox intnet mesh forms in ~5 s, and a 4-milestone from-source boot capture on one node
yielded `buildMs ≈ 4958 ms` + `meshFormMs ≈ 4681 ms` (see
[`experiments/mprr-boot-benchmark/fixtures/vbox-boot-4milestone-collab-cli-v0.11.0.json`](../../../../experiments/mprr-boot-benchmark/fixtures/vbox-boot-4milestone-collab-cli-v0.11.0.json)).

## Topology

Two (or more) actor nodes, each with **two NICs**:

| NIC | VBox | Guest | Purpose |
|---|---|---|---|
| nic1 | NAT + host SSH port-forward | `enp0s3` | control plane: SSH, journald read, `screenshotpng` capture |
| nic2 | **internal network** `intnet "lbamesh"` | `enp0s8` | mesh plane: lbabus net TCP/UDP between actors |

An **internal network** (not host-only) is used deliberately: VM↔VM mesh needs no host, and `intnet` avoids
the host-only kernel module / `/etc/vbox/networks.conf` range / permission friction. The mesh NIC gets a
static IP (`192.168.56.11`, `.12`, …) **self-assigned by the mesh unit's `ExecStartPre`** — a VBox intnet has
no DHCP and NetworkManager owns the Ubuntu desktop, so setting it in the unit is renderer-agnostic and
per-node (from `/etc/lba-mesh-actor`).

## Why the unit differs from the VMware one

[`lba-mesh.service`](lba-mesh.service) is **clone-friendly** (identity via `EnvironmentFile=/etc/lba-mesh-actor`,
not baked `Environment=` lines) and:

- **drops `network-online.target`** from `After`/`Wants` — on a VBox intnet NIC with no DHCP it stalls the
  mesh waiting for a NIC that never comes "online" via NM;
- **self-assigns the mesh IP** in `ExecStartPre` (`ip addr replace ${MESH_BIND}/24 dev ${MESH_IFACE}`);
- keeps `MESH_BIND` (→ lbabus `net --bind`) so beacons egress the mesh NIC, not the NAT default route;
- keeps `After=/Wants=lba-lbabus-build.service` (wait for the from-source build) + `Restart=always` (self-heal
  regardless of boot order).

## Recipe (2-node, proven)

Prereq: a **golden** VM with lbabus build-from-source ([`../../provision-lbabus-fromsource.sh`](../../provision-lbabus-fromsource.sh))
+ the emit units + the helper at `/usr/local/bin/emit-boot-marker.sh`.

```sh
GOLDEN=lba-ubuntu2404-labview2026-scratch

# 1. mesh NIC (nic2 -> intnet) on the golden, then snapshot + linked-clone the peer(s)
VBoxManage modifyvm "$GOLDEN" --nic2 intnet --intnet2 lbamesh --nictype2 82540EM --cableconnected2 on
VBoxManage snapshot "$GOLDEN" take mesh-node-ready
VBoxManage clonevm "$GOLDEN" --name lba-mesh-12 --options link --snapshot mesh-node-ready --register
# give the clone its own SSH port so both can run
VBoxManage modifyvm lba-mesh-12 --natpf1 delete ssh
VBoxManage modifyvm lba-mesh-12 --natpf1 "ssh,tcp,127.0.0.1,2223,,22"

# 2. per-node mesh layer (run provision-mesh-node.sh IN each guest as root)
#    node A (golden):  MESH_AGENT=mesh-11 MESH_SELF_IP=192.168.56.11 MESH_PEER_IPS=192.168.56.12
#    node B (clone) :  MESH_AGENT=mesh-12 MESH_SELF_IP=192.168.56.12 MESH_PEER_IPS=192.168.56.11
#    (each node's MESH_PEER_IPS = the OTHER nodes' IPs only)

# 3. boot the PEER(s) first (they build lbabus + wait for the captured node), then capture node A's boot:
#    remove /usr/local/bin/lbabus on the captured node (fresh from-source boot), then
LBA_MATCH=lbabench \
LBA_MILESTONES=BOOT-START,LBABUS-BUILD-START,LBABUS-BUILT,MESH-OK \
LBA_ITERATION=collab-cli-v0.11.0-mesh \
node experiments/mprr-boot-benchmark/record-vbox-boot.mjs
```

The captured node boots → builds lbabus → `lba-mesh` self-assigns its IP + forms the mesh with the running
peer → `MESH OK` → the MESH-OK marker is emitted (serial pin + journald `lbabench` line) → the recorder pins
all 4 milestones and seals a `boot-benchmark-v1` with `buildMs` **and** `meshFormMs`.

## Files

| File | Role |
|---|---|
| [`lba-mesh.service`](lba-mesh.service) | the generic (clone-friendly) VBox intnet mesh unit |
| [`provision-mesh-node.sh`](provision-mesh-node.sh) | per-node in-guest mesh setup (runtime + unit + `/etc/lba-mesh-actor`) |

## Status

Proven manually end-to-end (mesh forms; 4-milestone capture sealed). A single `VBoxManage`-driven
orchestrator (clone + per-node provision + boot order in one command) is a reasonable follow-up; the pieces
here are the reusable core.
