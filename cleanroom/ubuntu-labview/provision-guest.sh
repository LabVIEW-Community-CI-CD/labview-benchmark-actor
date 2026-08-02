#!/usr/bin/env bash
# Shared, provider-agnostic guest provisioner: installs LabVIEW 2026 Community + VIPM for Linux (UNACTIVATED)
# on a fresh Ubuntu 24.04 guest. Run this IN the guest after the unattended OS install, on BOTH the
# VirtualBox (LINUX plane) and VMware (WIN plane) VMs — the SAME script, so the LabVIEW layer is
# byte-for-byte parity across the two hypervisors.
#
# ACTIVATION (NI-account sign-in) is ALWAYS the operator's step — this script NEVER activates.
#
# The NI LabVIEW 2026 Community feed is an apt REPO (a public keyring + a `deb` source line) — the defaults
# below are AUTHORITATIVE, mirrored from the maintainer host that runs LabVIEW 2026 Community. The keyring
# is a PUBLIC PGP key bundled next to this script. Override NI_REPO / NI_SUITE / LABVIEW_PKG / NI_KEYRING if
# NI moves the feed.
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

# 1b) Passwordless sudo for the primary 'actor' user (cross-plane identity parity with the Windows
#     cleanroom; used by the downstream Vagrant golden box + mesh clones). Idempotent; validated by visudo.
PRIMARY_USER="${PRIMARY_USER:-actor}"
if id "$PRIMARY_USER" >/dev/null 2>&1; then
  log "configuring passwordless sudo for '$PRIMARY_USER'..."
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$PRIMARY_USER" > "/etc/sudoers.d/90-${PRIMARY_USER}-nopasswd"
  chmod 0440 "/etc/sudoers.d/90-${PRIMARY_USER}-nopasswd"
  visudo -cf "/etc/sudoers.d/90-${PRIMARY_USER}-nopasswd" >/dev/null
else
  log "[warn] primary user '$PRIMARY_USER' not present — skipping passwordless sudo (override with PRIMARY_USER)."
fi

# 2) NI LabVIEW 2026 Community feed = an apt REPO (public keyring + a `deb` source line), NOT a single .deb.
#    These defaults are AUTHORITATIVE — mirrored from the maintainer host (verified via
#    /etc/apt/sources.list.d/ni-labview-2026-noble-community.list + dpkg). Override via env if NI moves them.
NI_KEYRING_SRC="${NI_KEYRING:-$(dirname "$(readlink -f "$0")")/ni-labview-2026-noble-community.asc}"
NI_KEYRING_DST="/usr/share/keyrings/ni-labview-2026-noble-community.asc"
NI_LIST="/etc/apt/sources.list.d/ni-labview-2026-noble-community.list"
NI_REPO="${NI_REPO:-https://download.ni.com/ni-linux-desktop/LabVIEW/2026/Q1/f1/community/deb/ni-labview-2026/noble}"
NI_SUITE="${NI_SUITE:-ni-labview-2026}"
LABVIEW_PKG="${LABVIEW_PKG:-ni-labview-2026-community}"

if [ ! -f "$NI_KEYRING_SRC" ]; then
  echo "[provision] NI keyring not found: $NI_KEYRING_SRC" >&2
  echo "  It is a PUBLIC PGP key bundled next to this script (copied from the host's" >&2
  echo "  /usr/share/keyrings/ni-labview-2026-noble-community.asc). Set NI_KEYRING to override." >&2
  exit 3
fi

log "adding NI apt repo + keyring, installing '$LABVIEW_PKG' (UNACTIVATED)..."
install -m 0644 "$NI_KEYRING_SRC" "$NI_KEYRING_DST"
printf 'deb [signed-by=%s] %s noble %s\n' "$NI_KEYRING_DST" "$NI_REPO" "$NI_SUITE" > "$NI_LIST"
apt-get update -y
apt-get install -y "$LABVIEW_PKG"

# 2b) VI Package Manager (VIPM) -- the official LabVIEW add-on manager (JKI). It is NOT in the NI apt repo;
#     JKI ships a direct Debian package (application/vnd.debian.binary-package). Override VIPM_DEB_URL if JKI
#     moves it. Idempotent: skips if vipm is already installed. `apt-get install -f` resolves its deps.
VIPM_DEB_URL="${VIPM_DEB_URL:-https://packages.jki.net/vipm/preview/vipm_latest_preview_amd64.deb}"
if dpkg -s vipm >/dev/null 2>&1; then
  log "VIPM already installed ($(dpkg-query -W -f='${Version}' vipm 2>/dev/null)); skipping."
else
  log "downloading + installing VIPM (JKI) from $VIPM_DEB_URL ..."
  apt-get install -y --no-install-recommends wget
  wget -qO /tmp/vipm.deb "$VIPM_DEB_URL"
  dpkg -i /tmp/vipm.deb || apt-get install -f -y
  rm -f /tmp/vipm.deb
  log "VIPM installed ($(dpkg-query -W -f='${Version}' vipm 2>/dev/null || echo unknown))."
fi

log 'LabVIEW 2026 Community installed but NOT activated.'
log 'OPERATOR: activate LabVIEW Community (NI-account sign-in), then snapshot "labview2026-activated-ready".'
