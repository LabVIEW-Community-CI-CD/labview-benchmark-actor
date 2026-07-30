#!/usr/bin/env bash
# From-scratch VirtualBox builder for the Ubuntu 24.04 + LabVIEW 2026 Community clean room (LINUX plane).
#
# Reproduces — from NOTHING but the stock public Ubuntu 24.04 ISO — the operator's working VM
# `lba-ubuntu2404-labview2026` (Ubuntu 24.04 LTS, BIOS/PIIX3, 12 GB / 6 vCPU, 128 MB VRAM vmsvga,
# SATA-AHCI system disk, NAT). Nothing pre-built is distributed: the user supplies the stock Ubuntu ISO;
# this script creates the VM + unattended-installs Ubuntu + VirtualBox Guest Additions. LabVIEW 2026
# Community is then installed by provision-guest.sh (UNACTIVATED); ACTIVATION is the operator's step.
#
# This is the VirtualBox (LINUX-plane) reference. The WIN plane mirrors it on VMware (see README.md) with
# the SAME guest spec + the SAME provision-guest.sh — only the hypervisor-creation step differs.
#
# SAFE BY DEFAULT: prints the exact VBoxManage commands (dry-run). Pass --run to execute. Refuses to touch
# an existing VM of the same name unless --force (so it never clobbers the operator's real VM).
set -euo pipefail

VM_NAME="${VM_NAME:-lba-ubuntu2404-labview2026-scratch}"
ISO="${ISO:-}"                        # path to the stock Ubuntu 24.04 ISO (you download it; required for --run)
DISK_GB="${DISK_GB:-80}"              # matches build-vmware.ps1 (headroom for the full LabVIEW 2026 stack)
MEM_MB="${MEM_MB:-12288}"             # matches the operator's working VM
CPUS="${CPUS:-6}"
VRAM_MB="${VRAM_MB:-128}"
OSTYPE_ID="${OSTYPE_ID:-Ubuntu24_LTS_64}"   # verify on your host: VBoxManage list ostypes | grep -i ubuntu
BASEFOLDER="${BASEFOLDER:-$HOME/VirtualBox VMs}"
GUEST_USER="${GUEST_USER:-actor}"           # 'actor' = cross-plane identity parity with the Windows cleanroom
GUEST_FULLNAME="${GUEST_FULLNAME:-LBA Actor}"
GUEST_HOSTNAME="${GUEST_HOSTNAME:-actor}"
START_MODE="${START_MODE:-headless}"        # headless | gui | none
DRY_RUN=1
FORCE=0

usage() {
  sed -n '2,13p' "$0"
  echo
  echo "Usage:  ISO=/path/ubuntu-24.04-desktop-amd64.iso $0 [--run] [--force] [--gui|--headless]"
  echo "Env overrides: VM_NAME DISK_GB MEM_MB CPUS VRAM_MB OSTYPE_ID BASEFOLDER GUEST_USER GUEST_FULLNAME GUEST_HOSTNAME"
  echo "               GUEST_PASSWORD (local dev-only; defaults to 'actor'; written to a 0600 temp file)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --run)       DRY_RUN=0 ;;
    --dry-run)   DRY_RUN=1 ;;
    --force)     FORCE=1 ;;
    --gui)       START_MODE=gui ;;
    --headless)  START_MODE=headless ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else echo "  + $*"; "$@"; fi
}

command -v VBoxManage >/dev/null 2>&1 || { echo "[abort] VBoxManage not found — install VirtualBox." >&2; exit 1; }

# Safety: never clobber the operator's real VM (or any existing VM of this name).
if VBoxManage list vms | grep -q "\"$VM_NAME\""; then
  if [ "$FORCE" = 1 ]; then
    echo "[warn] VM '$VM_NAME' exists — --force given, continuing."
  else
    echo "[abort] VM '$VM_NAME' already exists. Choose a new VM_NAME or pass --force." >&2; exit 1
  fi
fi

if [ "$DRY_RUN" = 0 ]; then
  [ -n "$ISO" ]   || { echo "[abort] --run needs ISO=/path/to/ubuntu-24.04-*.iso (stock ISO you download)." >&2; exit 1; }
  [ -f "$ISO" ]   || { echo "[abort] ISO not found: $ISO" >&2; exit 1; }
fi

VM_DIR="$BASEFOLDER/$VM_NAME"
DISK="$VM_DIR/$VM_NAME.vdi"

echo "== From-scratch VirtualBox build: $VM_NAME =="
echo "   $OSTYPE_ID | ${MEM_MB} MB RAM | ${CPUS} vCPU | ${VRAM_MB} MB VRAM | ${DISK_GB} GB SATA-AHCI | NAT | BIOS/PIIX3"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run — printing commands only; pass --run to execute)"
echo

# 1) Create + register the VM.
run VBoxManage createvm --name "$VM_NAME" --ostype "$OSTYPE_ID" --basefolder "$BASEFOLDER" --register

# 2) Match the operator's working-VM hardware profile (BIOS firmware, PIIX3 chipset, vmsvga gfx).
run VBoxManage modifyvm "$VM_NAME" \
  --memory "$MEM_MB" --cpus "$CPUS" --vram "$VRAM_MB" --graphicscontroller vmsvga \
  --chipset piix3 --firmware bios --ioapic on --rtcuseutc on --nic1 nat

# 3) SATA-AHCI system disk (matches the real VM's IntelAhci controller).
run VBoxManage createmedium disk --filename "$DISK" --size "$((DISK_GB * 1024))" --format VDI
run VBoxManage storagectl "$VM_NAME" --name SATA --add sata --controller IntelAhci --portcount 2 --bootable on
run VBoxManage storageattach "$VM_NAME" --storagectl SATA --port 0 --device 0 --type hdd --medium "$DISK"

# 4) IDE optical controller (the install ISO rides here; auto-ejected after install — as on the real VM).
run VBoxManage storagectl "$VM_NAME" --name IDE --add ide --controller PIIX4

# 5) Unattended Ubuntu 24.04 install + Guest Additions, straight from the stock ISO. The local dev-only
#    guest credential is written to a 0600 temp file — never on the CLI (process list) or in the repo.
PWFILE="$(mktemp)"; chmod 600 "$PWFILE"; printf '%s' "${GUEST_PASSWORD:-actor}" > "$PWFILE"
trap 'rm -f "$PWFILE"' EXIT

UNATTENDED_ARGS=(
  "$VM_NAME"
  "--iso=${ISO:-/path/to/ubuntu-24.04-desktop-amd64.iso}"
  "--user=$GUEST_USER" "--password-file=$PWFILE" "--full-user-name=$GUEST_FULLNAME"
  --install-additions --locale=en_US --country=US --time-zone=UTC
  "--hostname=${GUEST_HOSTNAME}.local"
)
[ "$START_MODE" != none ] && UNATTENDED_ARGS+=( "--start-vm=$START_MODE" )
run VBoxManage unattended install "${UNATTENDED_ARGS[@]}"

cat <<NEXT

Next (matches the operator's real snapshot workflow):
  1) After the unattended install finishes + the guest reboots, copy provision-guest.sh into the guest and
     install LabVIEW 2026 Community (UNACTIVATED):        sudo ./provision-guest.sh
  2) Snapshot the clean pre-activation state:             VBoxManage snapshot "$VM_NAME" take labview2026-installed-preactivation
  3) OPERATOR activates LabVIEW Community (NI sign-in), then snapshot the activated state:
                                                          VBoxManage snapshot "$VM_NAME" take labview2026-activated-ready

WIN mirrors steps 1-3 on VMware — same guest spec + the SAME provision-guest.sh — see README.md.
NEXT
