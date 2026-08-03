#!/usr/bin/env bash
# request-step.sh -- the agent side of the Handoff Beacon agent->human request (LBA-REQ-056, ADR-0036).
#
# Writes an agent-request@1 beacon into the reviewer VM's handoff/requests/<id>.json so the extension surfaces
# the ask IN the VM as a VS Code notification with a "Mark step done" / "Skip" action, then runs the guest poll
# ONCE and BLOCKS until the human's op-done@1 answer lands in handoff/done/<id>.json (or a bounded timeout),
# printing the resolved answer on stdout. This closes the OTHER direction from await-handoff.sh: the agent's ask
# becomes a machine-observable, in-VM event instead of a chat relay. This is the ONE sanctioned poll in the flow.
#
# Preconditions: VBoxManage + node on PATH; the reviewer VM booted with the extension installed (it creates +
# watches handoff/requests/). The VM password is a LOCAL throwaway cred -- pass it via LBA_VM_PASS (never
# committed):
#   LBA_VM_PASS=... reviewer-workstation/request-step.sh \
#     --title "Run the streaming VI, then Stop the capture" --body "~12 MB/s for a few seconds" --timeout 900
# Prints e.g. {"schema":".../op-done@1","requestId":"req-...","outcome":"done","note":"ran VI #3",...}
# or {"outcome":"timeout","requestId":"req-..."} if the deadline passes.
set -euo pipefail

vm="actor"; interval=3; timeout=900; title=""; body=""; id=""; kind="step"
user="${LBA_VM_USER:-vagrant}"
: "${LBA_VM_PASS:?set LBA_VM_PASS to the reviewer VM password (a local throwaway cred; never commit it)}"
pass="$LBA_VM_PASS"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)       vm="$2";       shift 2 ;;
    --title)    title="$2";    shift 2 ;;
    --body)     body="$2";     shift 2 ;;
    --id)       id="$2";       shift 2 ;;
    --kind)     kind="$2";     shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --timeout)  timeout="$2";  shift 2 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "request-step: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$title" ]] || { echo "request-step: --title is required" >&2; exit 2; }
[[ -n "$id" ]] || id="req-$(date +%s)"
command -v VBoxManage >/dev/null || { echo "request-step: VBoxManage not on PATH" >&2; exit 3; }
command -v node >/dev/null || { echo "request-step: node not on PATH" >&2; exit 3; }

gc() { VBoxManage guestcontrol "$vm" --username "$user" --password "$pass" "$@"; }

# 1. Build the validated agent-request@1 beacon JSON locally (same pure builder the extension + gate use).
tmp="$(mktemp -d)"
node "$here/build-agent-request.mjs" --id "$id" --title "$title" --body "$body" --kind "$kind" > "$tmp/$id.json"

# 2. Drop it into the guest handoff/requests/ dir (create it first; the extension also creates + watches it).
guest_req="C:\\Users\\${user}\\AppData\\Roaming\\Code\\User\\globalStorage\\labview-community-ci-cd.labview-benchmark-actor\\handoff\\requests"
gc run --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout -- powershell -Command "New-Item -ItemType Directory -Force -Path '${guest_req}' | Out-Null" >/dev/null 2>&1 || true
gc copyto --target-directory "${guest_req}\\" "$tmp/$id.json" >/dev/null
echo "[request-step] asked the human in the VM: ${title} (id=${id}); awaiting op-done (poll ${interval}s, timeout ${timeout}s) ..." >&2

# 3. Run the guest poll ONCE + block until the op-done beacon resolves or the timeout.
gc run --exe 'C:\Windows\System32\cmd.exe' --wait-stdout -- cmd /c "if not exist C:\lba-review mkdir C:\lba-review" >/dev/null 2>&1 || true
gc copyto --target-directory 'C:\lba-review\' "$here/request-step.ps1" >/dev/null
gc run --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout -- \
  powershell -ExecutionPolicy Bypass -File 'C:\lba-review\request-step.ps1' "$id" "$timeout" "$interval"
rm -rf "$tmp"
