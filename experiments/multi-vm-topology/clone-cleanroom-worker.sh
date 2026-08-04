#!/usr/bin/env bash
# Intelligent cleanroom CLONER: linked-clone a golden Ubuntu+LabVIEW base VM into a capability-differentiated
# worker VM, provision it (Node + the experiments/ harness), and launch the provider-delegation worker as a
# PERSISTENT transient systemd unit. Complements cleanroom/ubuntu-labview/build-virtualbox.sh (which builds the
# golden base from a stock Ubuntu ISO from scratch): build-from-scratch -> golden snapshot -> clone-to-N-workers.
#
# Proven end-to-end by experiments/provider-delegation/prove-2vm-routing.mjs (receipt
# cross-machine-2vm-routing-evidence.json): the host router discovers the clone over the bus, sees its
# capabilities, and routes by capability across the base + clone. Idempotent: safe to re-run.
#
# Usage:  clone-cleanroom-worker.sh [CLONE_VM] [SSH_PORT] [WORKER_PORT] [ACTOR_ID]
# Example: ./clone-cleanroom-worker.sh lba-cleanroom-clone-02 2224 7442 cleanroom-clone-02
#
# Key learnings baked in:
#  - VM disks live on the roomy Data drive; linked clones share the base disk + store only deltas.
#  - Each clone needs DISTINCT host NAT ports (SSH + worker) since all VMs use NAT (guest 10.0.2.15 each).
#  - The worker MUST run as a systemd unit: logind KillUserProcesses reaps plain nohup/setsid background
#    processes when the SSH session closes, so a detached `node worker.mjs &` does not survive.
#  - The harness has cross-directory relative imports (provider-delegation -> ollama-comparison ->
#    host-concentration ...), so the WHOLE experiments/ tree is synced (not just provider-delegation/).
set -euo pipefail

BASE_VM="${BASE_VM:-lba-ubuntu2404-labview2026-scratch}"
SNAPSHOT="${SNAPSHOT:-mesh-node-ready}"
CLONE_VM="${1:-lba-cleanroom-clone-01}"
SSH_PORT="${2:-2223}"
WORKER_PORT="${3:-7441}"
ACTOR_ID="${4:-cleanroom-clone}"
GUEST_USER="${GUEST_USER:-actor}"
PROVIDER="${PROVIDER:-mock}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lba_scratch}"
# VirtualBox stores VM disks on the Data drive here by default on this host; override for other hosts.
BASEFOLDER="${BASEFOLDER:-/run/media/$USER/Data/lba-vagrant/VirtualBox VMs}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSHOPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10)

log() { echo "[clone-cleanroom] $*"; }
guest() { ssh -n "${SSHOPTS[@]}" -p "$SSH_PORT" "${GUEST_USER}@127.0.0.1" "$@"; }

# 1) Linked clone from the golden snapshot (idempotent).
if VBoxManage showvminfo "$CLONE_VM" >/dev/null 2>&1; then
  log "clone '$CLONE_VM' already exists -- skipping creation"
else
  log "linked-cloning $BASE_VM@$SNAPSHOT -> $CLONE_VM"
  VBoxManage clonevm "$BASE_VM" --snapshot "$SNAPSHOT" --options link --name "$CLONE_VM" --basefolder "$BASEFOLDER" --register
fi

# 2) Distinct NAT forwards (SSH + worker) + right-size -- only when powered off (modifyvm rejects a running VM).
if VBoxManage list runningvms | grep -q "\"$CLONE_VM\""; then
  log "$CLONE_VM is running -- assuming NAT/resources already configured"
else
  VBoxManage modifyvm "$CLONE_VM" --natpf1 delete ssh 2>/dev/null || true
  VBoxManage modifyvm "$CLONE_VM" --natpf1 delete worker 2>/dev/null || true
  VBoxManage modifyvm "$CLONE_VM" --natpf1 "ssh,tcp,127.0.0.1,${SSH_PORT},,22"
  VBoxManage modifyvm "$CLONE_VM" --natpf1 "worker,tcp,127.0.0.1,${WORKER_PORT},,${WORKER_PORT}"
  VBoxManage modifyvm "$CLONE_VM" --memory 6144 --cpus 2 || true
fi

# 3) Boot headless (idempotent).
if VBoxManage list runningvms | grep -q "\"$CLONE_VM\""; then
  log "$CLONE_VM already running"
else
  log "booting $CLONE_VM headless"
  VBoxManage startvm "$CLONE_VM" --type headless
fi

# 4) Wait for SSH.
log "waiting for SSH on 127.0.0.1:${SSH_PORT} ..."
for i in $(seq 1 60); do
  if guest true 2>/dev/null; then log "SSH up"; break; fi
  [ "$i" = 60 ] && { log "ERROR: SSH never came up"; exit 1; }
  sleep 2
done

# 5) Provision: Node (if missing) + sync the WHOLE experiments/ harness (sibling dirs needed by imports).
log "provisioning Node + harness"
guest 'command -v node >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs; }'
TARBALL="$(mktemp /tmp/lba-experiments-XXXXXX.tgz)"
tar czf "$TARBALL" -C "$REPO_ROOT" --exclude='*/node_modules' --exclude='.git' experiments
scp "${SSHOPTS[@]}" -P "$SSH_PORT" "$TARBALL" "${GUEST_USER}@127.0.0.1:~/lba-experiments.tgz" >/dev/null
guest 'rm -rf ~/experiments && tar xzf ~/lba-experiments.tgz -C ~'
rm -f "$TARBALL"

# 5b) Make the clone CAPTURE-READY for the mprr visual ring (live-vbox-labview-trend.mjs). Xorg.wrap refuses
# `xinit` from a non-console (SSH) session unless Xwrapper.config allows it -- without this a launch-to-ready
# capture sees a STATIC screen and reports a bogus ~85 ms launchMs. (Learned 2026-08: a fresh mesh-node-ready
# clone lacked this; setting allowed_users=anybody yields real timings, e.g. ~1.85 s to the LabVIEW IDE.)
log "making $CLONE_VM capture-ready (Xwrapper allowed_users=anybody)"
guest 'printf "allowed_users=anybody\nneeds_root_rights=yes\n" | sudo tee /etc/X11/Xwrapper.config >/dev/null'

# 6) Launch the worker as a PERSISTENT transient systemd unit (survives the SSH session).
log "launching worker (systemd unit lba-worker) on port ${WORKER_PORT} (provider=${PROVIDER}, actor=${ACTOR_ID})"
guest "sudo systemctl stop lba-worker 2>/dev/null || true; sudo systemd-run --unit=lba-worker --collect --working-directory=/home/${GUEST_USER}/experiments/provider-delegation /usr/bin/node worker.mjs --listen ${WORKER_PORT} --concurrency 2 --provider ${PROVIDER} --actor ${ACTOR_ID}"

# 7) Verify the worker is listening; the host reaches it at 127.0.0.1:${WORKER_PORT} via the NAT forward.
if guest "ss -tlnp 2>/dev/null | grep -q ':${WORKER_PORT} '"; then
  log "OK: worker LISTENING on ${WORKER_PORT}. Host reaches it at 127.0.0.1:${WORKER_PORT} (SSH 127.0.0.1:${SSH_PORT})."
else
  log "ERROR: worker not listening on ${WORKER_PORT}"; exit 1
fi
