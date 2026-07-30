#!/usr/bin/env bash
# Shared, provider-agnostic guest provisioner: installs LabVIEW 2026 Community for Linux (UNACTIVATED)
# on a fresh Ubuntu 24.04 guest. Run this IN the guest after the unattended OS install, on BOTH the
# VirtualBox (LINUX plane) and VMware (WIN plane) VMs — the SAME script, so the LabVIEW layer is
# byte-for-byte parity across the two hypervisors.
#
# ACTIVATION (NI-account sign-in) is ALWAYS the operator's step — this script NEVER activates.
#
# The exact NI feed .deb URL + LabVIEW package name are OPERATOR-CONFIRMED (set NI_FEED_DEB + LABVIEW_PKG).
# Without them the script prints the exact commands to run + where to get the NI feed, then stops
# (fail-closed) rather than guessing an unverified package name.
set -euo pipefail

log() { echo "[provision] $*"; }
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" = 0 ] || { echo "[abort] run as root:  sudo ./provision-guest.sh" >&2; exit 1; }

# Confirm we're on the intended base OS (24.04 = the operator's working-VM LTS).
if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${VERSION_ID:-}" = "24.04" ] || log "[warn] expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown} — continuing."
fi

# 1) Base tooling + the runtime libs LabVIEW's installer + IDE expect on a minimal Ubuntu.
log 'apt update + base packages...'
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg apt-transport-https \
  libglu1-mesa libxinerama1 libxrandr2 libxcursor1 libxi6 libgl1

NI_FEED_DEB="${NI_FEED_DEB:-}"
LABVIEW_PKG="${LABVIEW_PKG:-}"

if [ -z "$NI_FEED_DEB" ] || [ -z "$LABVIEW_PKG" ]; then
  cat <<'GUIDANCE'
[provision] LabVIEW install is operator-parameterized (exact NI strings TBC from the working VM).
  Provide BOTH, then re-run:
    NI_FEED_DEB=<URL of NI's Ubuntu-24.04 package-feed .deb from download.ni.com>
    LABVIEW_PKG=<e.g. labview-2026-community>    # confirm the EXACT package on the real VM:
                                                 #   dpkg -l | grep -i labview
  The install is then exactly:
    curl -fsSL "$NI_FEED_DEB" -o /tmp/ni-feed.deb && apt-get install -y /tmp/ni-feed.deb
    apt-get update -y && apt-get install -y "$LABVIEW_PKG"
  After install, the OPERATOR activates LabVIEW Community (NI sign-in). Activation is NEVER automated here.
GUIDANCE
  exit 3
fi

# 2) Add the NI package feed, then install LabVIEW 2026 Community (UNACTIVATED).
log "adding NI feed + installing '$LABVIEW_PKG' (UNACTIVATED)..."
curl -fsSL "$NI_FEED_DEB" -o /tmp/ni-feed.deb
apt-get install -y /tmp/ni-feed.deb
apt-get update -y
apt-get install -y "$LABVIEW_PKG"
rm -f /tmp/ni-feed.deb

log 'LabVIEW 2026 Community installed but NOT activated.'
log 'OPERATOR: activate LabVIEW Community (NI-account sign-in), then snapshot "labview2026-activated-ready".'
