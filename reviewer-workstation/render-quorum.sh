#!/usr/bin/env bash
# render-quorum.sh -- the host side of the machine QUORUM sign-off (#415, LBA-REQ-089 / ADR-0071 / ADR-0018).
#
# The machine quorum sign-off must be produced WHERE the enrolled Ed25519 key lives -- IN the reviewer VM
# (C:\lba-review\reviewer-vitech.pem) -- but the release flow builds the attestation on the HOST
# (~/lba-vm-share/attestation-<version>.json). The VISUAL verdict already has a host wrapper (render-verdict.sh);
# the quorum sign-off had NONE, so the 1.1.1 release stalled on a documented host-side `--key <host path>` that
# does not exist (the key is in the VM). This wrapper mirrors render-verdict.sh for the quorum: it stages the
# attestation into the VM, runs sign-release-quorum.mjs IN THE VM against the VM-resident key (the private key
# NEVER leaves the VM; only the PUBLIC acg-human-signoff-v1 is emitted), collects the signed sign-off back to the
# host, and verifies it against the attestation quorum + the enrolled allowlist.
#
# The in-VM node invocation goes through `cmd /c "cd /d <repo> && node ..."` so VBoxManage guestcontrol does not
# consume node's argv[0] as the main module (the MODULE_NOT_FOUND gotcha noted in #415).
#
# Preconditions: VBoxManage on PATH; the reviewer VM booted with a repo clone (C:\lba-validate\repo, left by
# win-plane-validate.sh) + the enrolled key at C:\lba-review\reviewer-vitech.pem. The VM password is a LOCAL
# throwaway cred -- pass it via LBA_VM_PASS (never committed):
#   LBA_VM_PASS=... reviewer-workstation/render-quorum.sh all --version 1.1.1 \
#       --attestation ~/lba-vm-share/attestation-1.1.1.json --out ~/lba-vm-share/quorum-signoff-1.1.1.json
#   (or run the stages individually: stage | sign | collect | verify)
set -euo pipefail

sub="${1:-}"; shift || true
vm="actor"; user="${LBA_VM_USER:-vagrant}"
reviewer="${LBA_REVIEWER_ID:-reviewer@vi-tech.nl}"
vm_repo='C:\lba-validate\repo'
vm_key="${LBA_VM_KEY:-C:\\lba-review\\reviewer-vitech.pem}"
vm_stage='C:\lba-review'
version=""; attestation=""; out=""; signoff=""
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
allowlist="${here}/../tools/collab-cli/reviewer-allowlist.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)          vm="$2";          shift 2 ;;
    --version)     version="$2";     shift 2 ;;
    --attestation) attestation="$2"; shift 2 ;;
    --signoff)     signoff="$2";     shift 2 ;;
    --out)         out="$2";         shift 2 ;;
    --reviewer)    reviewer="$2";    shift 2 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "render-quorum: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
# Top-level help: accept -h/--help/help as the subcommand (or no subcommand at all).
case "$sub" in -h|--help|help|'') grep '^#' "$0" | sed 's/^# \{0,1\}//'; [[ -z "$sub" ]] && exit 2 || exit 0 ;; esac
[[ -n "$version" ]] || { echo "render-quorum: --version is required" >&2; exit 2; }
: "${out:=${HOME}/lba-vm-share/quorum-signoff-${version}.json}"   # default host destination (overridable via --out)

# The VM-touching subcommands (everything but `verify`) need VBoxManage + the throwaway VM password. `verify` is a
# pure host-side node check (no VM, no secret), so it stays runnable without LBA_VM_PASS.
pass=""
if [[ "$sub" != "verify" ]]; then
  command -v VBoxManage >/dev/null || { echo "render-quorum: VBoxManage not on PATH" >&2; exit 3; }
  : "${LBA_VM_PASS:?set LBA_VM_PASS to the reviewer VM password (a local throwaway cred; never commit it)}"
  pass="$LBA_VM_PASS"
fi
gc() { VBoxManage guestcontrol "$vm" --username "$user" --password "$pass" "$@"; }
vm_att="${vm_stage}\\attestation-${version}.json"
vm_signoff="${vm_stage}\\quorum-signoff-${version}.json"

do_stage() {
  [[ -n "$attestation" && -f "$attestation" ]] || { echo "render-quorum: stage needs --attestation <file> (must exist)" >&2; exit 2; }
  gc run --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout -- \
    powershell -Command "New-Item -ItemType Directory -Force -Path '${vm_stage}' | Out-Null" >/dev/null 2>&1 || true
  gc copyto --target-directory "${vm_stage}\\" "$attestation" >/dev/null
  # copyto keeps the host basename; normalize to the deterministic staged name so `sign` finds it.
  local base; base="$(basename "$attestation")"
  if [[ "$base" != "attestation-${version}.json" ]]; then
    gc run --exe 'C:\Windows\System32\cmd.exe' --wait-stdout -- \
      cmd /c "move /Y \"${vm_stage}\\${base}\" \"${vm_att}\"" >/dev/null 2>&1 || true
  fi
  echo "[render-quorum] staged ${attestation} -> VM ${vm_att}" >&2
}

do_sign() {
  # Sign IN the VM (the enrolled key never leaves the VM). `cmd /c "cd /d <repo> && node ..."` avoids the
  # guestcontrol node-argv[0]/MODULE_NOT_FOUND gotcha; only the PUBLIC acg-human-signoff-v1 is written.
  gc run --exe 'C:\Windows\System32\cmd.exe' --wait-stdout --wait-stderr -- \
    cmd /c "cd /d ${vm_repo} && node reviewer-workstation\\sign-release-quorum.mjs --key ${vm_key} --reviewer ${reviewer} --station WINDOWS_VM --quorum ${vm_att} --out ${vm_signoff}"
  echo "[render-quorum] signed in the VM as ${reviewer} -> VM ${vm_signoff}" >&2
}

do_collect() {
  # copyfrom does NOT truncate an existing target -> remove any prior host file first (a shorter new sign-off
  # would otherwise leave the tail of a longer previous one = two concatenated records = unparseable JSON).
  rm -f "$out"
  gc copyfrom "$vm_signoff" "$out" >/dev/null
  echo "[render-quorum] collected the signed quorum sign-off -> ${out}" >&2
}

do_verify() {
  local sig="${signoff:-$out}"
  command -v node >/dev/null || { echo "render-quorum: node not on PATH" >&2; exit 3; }
  [[ -n "$attestation" && -f "$attestation" ]] || { echo "render-quorum: verify needs --attestation <host file>" >&2; exit 2; }
  node "${here}/verify-quorum-signoff.mjs" --attestation "$attestation" --signoff "$sig" --allowlist "$allowlist"
}

case "$sub" in
  stage)   do_stage ;;
  sign)    do_sign ;;
  collect) do_collect ;;
  verify)  do_verify ;;
  all)     do_stage; do_sign; do_collect; do_verify
           echo "[render-quorum] DONE: verified quorum sign-off for ${version} at ${out} (the private key never left the VM)" >&2 ;;
  *)       echo "usage: render-quorum.sh <stage|sign|collect|verify|all> --version X.Y.Z --attestation <file> [--out <file>] (see --help)" >&2; exit 2 ;;
esac
