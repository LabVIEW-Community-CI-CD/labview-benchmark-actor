#!/usr/bin/env bash
# win-plane-validate.sh -- host-side driver for an independent WIN-plane native-Windows build/test validation
# of a release branch, run in the reviewer VM (VirtualBox) via VBoxManage guestcontrol.
#
# Auth-free by design: the labview-benchmark-actor repo is private and the reviewer VM holds NO persisted
# credential (provision.ps1 reads a one-shot token file then deletes it), so a fresh guest session cannot
# `gh repo clone`. This transfers the branch as a self-contained git BUNDLE (no network/auth in the guest),
# clones it in the VM, and runs win-plane-validate.ps1 there. Prints the in-VM receipt (WINPLANE_JSON=...).
#
# Usage:
#   LBA_VM_PASS='<guest-password>' reviewer-workstation/win-plane-validate.sh [BRANCH] [VM]
#     BRANCH  release branch to validate (default: the current branch)
#     VM      running VirtualBox VM name  (default: actor)
#
# Requires: VBoxManage, a running reviewer VM, node/npm/git already present in the guest (the golden box
# ships them), and LBA_VM_PASS exported (the throwaway guest password -- never pass secrets on the CLI of a
# shared shell history if it is not a throwaway).
set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
VM="${2:-actor}"
: "${LBA_VM_PASS:?export LBA_VM_PASS (the guest password) before running}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPD="$(mktemp -d)"
BUNDLE="$TMPD/rel.bundle"
trap 'rm -rf "$TMPD"' EXIT

GC=(VBoxManage guestcontrol "$VM" --username vagrant --password "$LBA_VM_PASS")
PS='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
CMD='C:\Windows\System32\cmd.exe'

echo "[host] bundling $BRANCH -> $BUNDLE"
git bundle create "$BUNDLE" "$BRANCH"
git bundle verify "$BUNDLE" >/dev/null

echo "[host] staging bundle + validator + mask into $VM:C:\\lba-validate"
"${GC[@]}" run --exe "$CMD" --wait-stdout -- cmd /c "if not exist C:\lba-validate mkdir C:\lba-validate" >/dev/null
"${GC[@]}" copyto --target-directory 'C:\lba-validate\' "$BUNDLE" >/dev/null
"${GC[@]}" copyto --target-directory 'C:\lba-validate\' "$HERE/labview-mask.cjs" "$HERE/win-plane-validate.ps1" >/dev/null

echo "[host] validating $BRANCH in-VM (npm ci + per-suite tests + masked activation + packaging gate)"
"${GC[@]}" run --exe "$PS" --wait-stdout -- powershell -NoProfile -ExecutionPolicy Bypass \
  -File 'C:\lba-validate\win-plane-validate.ps1' -Bundle 'C:\lba-validate\rel.bundle' -Branch "$BRANCH"
