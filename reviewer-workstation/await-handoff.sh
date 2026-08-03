#!/usr/bin/env bash
# await-handoff.sh -- await a human-in-the-loop capture step via the Handoff Beacon (LBA-REQ-055, ADR-0035).
#
# The reviewer VM's extension writes a capture-status.json beacon when the operator clicks "Stop LabVIEW
# Capture" (state:stopped with a rich payload -- wroteToDisk, peak write MB/s + the frame index where it peaked,
# per-disk breakdown -- or state:failed on assembly error). This host-side wrapper runs the guest poll ONCE and
# BLOCKS until the beacon resolves or the timeout elapses, then prints the resolved beacon JSON on stdout. So the
# agent leverages human assistance efficiently: it awaits the Stop instead of guessing or re-asking, and jumps
# straight to the evidence (the peak-write frame) from the payload. This is the ONE sanctioned poll in the flow.
#
# Preconditions: VBoxManage on PATH; the reviewer VM booted with the extension installed; a capture running.
# The VM password is a LOCAL throwaway cred -- pass it via LBA_VM_PASS (never committed): 
#   LBA_VM_PASS=... reviewer-workstation/await-handoff.sh --vm actor --interval 3 --timeout 900
# Prints e.g. {"state":"stopped","peak":{"writeMBs":134.5,"frameIndex":1122,"disk":"0 C:"},...} or {"state":"timeout"}.
set -euo pipefail

vm="actor"; interval=3; timeout=900
user="${LBA_VM_USER:-vagrant}"
: "${LBA_VM_PASS:?set LBA_VM_PASS to the reviewer VM password (a local throwaway cred; never commit it)}"
pass="$LBA_VM_PASS"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)       vm="$2";       shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --timeout)  timeout="$2";  shift 2 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "await-handoff: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
command -v VBoxManage >/dev/null || { echo "await-handoff: VBoxManage not on PATH" >&2; exit 3; }

gc() { VBoxManage guestcontrol "$vm" --username "$user" --password "$pass" "$@"; }

# Stage + run the guest poll (blocks until the beacon resolves or the timeout).
gc run --exe 'C:\Windows\System32\cmd.exe' --wait-stdout -- cmd /c "if not exist C:\lba-review mkdir C:\lba-review" >/dev/null 2>&1 || true
gc copyto --target-directory 'C:\lba-review\' "$here/await-handoff.ps1" >/dev/null
echo "[await-handoff] watching for the capture Stop (poll ${interval}s, timeout ${timeout}s) ..." >&2
gc run --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout -- \
  powershell -ExecutionPolicy Bypass -File 'C:\lba-review\await-handoff.ps1' "$timeout" "$interval"
