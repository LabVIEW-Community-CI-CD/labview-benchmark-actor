#!/usr/bin/env bash
# render-verdict.sh -- the host side of the reviewer VISUAL VERDICT (LBA-REQ-057, ADR-0037).
#
# The human renders + Ed25519-SIGNS their PASS/FAIL of a release candidate IN the reviewer VM (the extension's
# "Render Reviewer Verdict" command, enrolled reviewer key). This host wrapper does the two VM-bridge steps
# around that:
#   set-target  -- write handoff/review-target.json into the VM (WHAT is under review: component, version,
#                  commit, .vsix sha256, evidence pointers) so the extension binds the verdict to the candidate.
#   collect     -- copy the signed verdict (handoff/verdicts/<component>-<version>.json) OUT of the VM so it can
#                  be added to release-agreement.json + keyless counter-signed in CI.
#
# Preconditions: VBoxManage on PATH; the reviewer VM booted with the extension installed. The VM password is a
# LOCAL throwaway cred -- pass it via LBA_VM_PASS (never committed):
#   LBA_VM_PASS=... reviewer-workstation/render-verdict.sh set-target --version 0.5.0 --commit <sha> --vsix-sha256 <sha> [--component extension] [--evidence <kind>:<ref>]...
#   LBA_VM_PASS=... reviewer-workstation/render-verdict.sh collect --version 0.5.0 [--component extension] --out <file.json>
set -euo pipefail

sub="${1:-}"; shift || true
vm="actor"; component="extension"; version=""; commit=""; vsix=""; out=""; evidence=()
user="${LBA_VM_USER:-vagrant}"
: "${LBA_VM_PASS:?set LBA_VM_PASS to the reviewer VM password (a local throwaway cred; never commit it)}"
pass="$LBA_VM_PASS"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)          vm="$2";        shift 2 ;;
    --component)   component="$2"; shift 2 ;;
    --version)     version="$2";   shift 2 ;;
    --commit)      commit="$2";    shift 2 ;;
    --vsix-sha256) vsix="$2";      shift 2 ;;
    --evidence)    evidence+=("$2"); shift 2 ;;
    --out)         out="$2";       shift 2 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "render-verdict: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
command -v VBoxManage >/dev/null || { echo "render-verdict: VBoxManage not on PATH" >&2; exit 3; }
[[ -n "$version" ]] || { echo "render-verdict: --version is required" >&2; exit 2; }

gc() { VBoxManage guestcontrol "$vm" --username "$user" --password "$pass" "$@"; }
guest_handoff="C:\\Users\\${user}\\AppData\\Roaming\\Code\\User\\globalStorage\\labview-community-ci-cd.labview-benchmark-actor\\handoff"

case "$sub" in
  set-target)
    command -v node >/dev/null || { echo "render-verdict: node not on PATH" >&2; exit 3; }
    # Build review-target.json locally (node JSON-escapes the evidence refs), then drop it into the VM handoff dir.
    tmp="$(mktemp -d)"
    COMP="$component" VER="$version" COMMIT="$commit" VSIX="$vsix" EVID="${evidence[*]:-}" node -e '
      const ev = (process.env.EVID || "").trim().split(/\s+/).filter(Boolean).map((s) => { const i = s.indexOf(":"); return { kind: i > 0 ? s.slice(0, i) : "note", ref: i > 0 ? s.slice(i + 1) : s }; });
      process.stdout.write(JSON.stringify({ component: process.env.COMP, version: process.env.VER, commit: process.env.COMMIT || null, vsixSha256: process.env.VSIX || null, evidence: ev }, null, 2));
    ' > "$tmp/review-target.json"
    gc run --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout -- powershell -Command "New-Item -ItemType Directory -Force -Path '${guest_handoff}' | Out-Null" >/dev/null 2>&1 || true
    gc copyto --target-directory "${guest_handoff}\\" "$tmp/review-target.json" >/dev/null
    rm -rf "$tmp"
    echo "[render-verdict] review target set in the VM: ${component} ${version} (commit ${commit:-none}). Run 'Render Reviewer Verdict' in the VM to sign." >&2
    ;;
  collect)
    [[ -n "$out" ]] || { echo "render-verdict: collect requires --out <file.json>" >&2; exit 2; }
    src="${guest_handoff}\\verdicts\\${component}-${version}.json"
    gc copyfrom --target-directory "$(dirname "$out")" "$src" >/dev/null
    mv -f "$(dirname "$out")/${component}-${version}.json" "$out"
    echo "[render-verdict] collected the signed verdict -> ${out}" >&2
    ;;
  *)
    echo "usage: render-verdict.sh <set-target|collect> ... (see --help)" >&2
    exit 2
    ;;
esac
