#!/usr/bin/env bash
# render-quorum.sh -- host wrapper for VM-side machine quorum sign-off (issue #415).
#
# Why: the enrolled reviewer key commonly lives in the Windows reviewer VM, while the cross-plane attestation is on
# the host share. This script bridges that split in one command:
#   1) stage attestation into the VM,
#   2) run sign-release-quorum.mjs IN the VM (cmd /c from the VM repo clone),
#   3) collect quorum-signoff-<version>.json back to the host,
#   4) verify the sign-off matches the attestation quorum and an enrolled reviewer.
#
# Usage:
#   LBA_VM_PASS=... reviewer-workstation/render-quorum.sh sign --version 1.2.3
#   LBA_VM_PASS=... reviewer-workstation/render-quorum.sh sign --version 1.2.3 \
#     --attestation ~/lba-vm-share/attestation-1.2.3.json \
#     --out ~/lba-vm-share/quorum-signoff-1.2.3.json
set -euo pipefail

sub="${1:-}"; shift || true
vm="${LBA_VM_NAME:-actor}"
user="${LBA_VM_USER:-vagrant}"
reviewer=""
key=""
version=""
attestation=""
out=""
guest_repo='C:\lba-validate\repo'
guest_stage='C:\lba-review'
cmd='C:\Windows\System32\cmd.exe'
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/.." && pwd)"

: "${LBA_VM_PASS:?set LBA_VM_PASS to the reviewer VM password (a local throwaway cred; never commit it)}"
pass="$LBA_VM_PASS"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)          vm="$2";          shift 2 ;;
    --user)        user="$2";        shift 2 ;;
    --version)     version="$2";     shift 2 ;;
    --attestation) attestation="$2"; shift 2 ;;
    --out)         out="$2";         shift 2 ;;
    --reviewer)    reviewer="$2";    shift 2 ;;
    --key)         key="$2";         shift 2 ;;
    --guest-repo)  guest_repo="$2";  shift 2 ;;
    --guest-stage) guest_stage="$2"; shift 2 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "render-quorum: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

command -v VBoxManage >/dev/null || { echo "render-quorum: VBoxManage not on PATH" >&2; exit 3; }
command -v node >/dev/null || { echo "render-quorum: node not on PATH" >&2; exit 3; }

[[ "$sub" == "sign" ]] || { echo "usage: render-quorum.sh sign ... (see --help)" >&2; exit 2; }
[[ -n "$version" ]] || { echo "render-quorum: --version is required" >&2; exit 2; }
attestation="${attestation:-$HOME/lba-vm-share/attestation-${version}.json}"
out="${out:-$HOME/lba-vm-share/quorum-signoff-${version}.json}"
[[ -f "$attestation" ]] || { echo "render-quorum: attestation not found: $attestation" >&2; exit 2; }

gc() { VBoxManage guestcontrol "$vm" --username "$user" --password "$pass" "$@"; }
gc_cmd() { gc run --exe "$cmd" --wait-stdout --wait-stderr -- cmd /c "$1"; }

if [[ -z "$reviewer" || -z "$key" ]]; then
  settings="C:\\Users\\${user}\\AppData\\Roaming\\Code\\User\\settings.json"
  settings_json="$(gc_cmd "type \"$settings\"")"
  parsed="$(
    SETTINGS_JSON="$settings_json" node --input-type=module -e '
      const cfg = JSON.parse(process.env.SETTINGS_JSON || "{}");
      const reviewer = String(cfg["labviewBenchmarkActor.reviewerId"] || "").trim();
      const key = String(cfg["labviewBenchmarkActor.reviewerKeyPath"] || "").trim();
      process.stdout.write(`${reviewer}\n${key}`);
    '
  )"
  if [[ -z "$reviewer" ]]; then reviewer="$(printf '%s\n' "$parsed" | sed -n '1p')"; fi
  if [[ -z "$key" ]]; then key="$(printf '%s\n' "$parsed" | sed -n '2p')"; fi
fi

[[ -n "$reviewer" ]] || { echo "render-quorum: reviewerId is required (set --reviewer or labviewBenchmarkActor.reviewerId in VM settings)" >&2; exit 2; }
[[ -n "$key" ]] || { echo "render-quorum: reviewer key path is required (set --key or labviewBenchmarkActor.reviewerKeyPath in VM settings)" >&2; exit 2; }
if ! gc_cmd "if exist \"$key\" (echo YES) else (echo NO)" | grep -q 'YES'; then
  echo "render-quorum: reviewer key does not exist in VM at $key" >&2
  exit 2
fi

gc_cmd "if not exist \"$guest_stage\" mkdir \"$guest_stage\"" >/dev/null
gc_cmd "if not exist \"$guest_repo\" (echo MISSING_REPO && exit /b 2)" >/dev/null || {
  echo "render-quorum: VM repo path not found: $guest_repo (expected from win-plane-validate.sh)" >&2
  exit 2
}

att_name="$(basename "$attestation")"
guest_att="${guest_stage}\\${att_name}"
guest_out="${guest_stage}\\quorum-signoff-${version}.json"

echo "[render-quorum] staging attestation into VM: $attestation -> $guest_att" >&2
gc copyto --target-directory "${guest_stage}\\" "$attestation" >/dev/null

echo "[render-quorum] signing in VM as ${reviewer} with key ${key}" >&2
gc_cmd "cd /d \"$guest_repo\" && node reviewer-workstation\\sign-release-quorum.mjs --key \"$key\" --reviewer \"$reviewer\" --station WINDOWS_VM --quorum \"$guest_att\" --out \"$guest_out\""

mkdir -p "$(dirname "$out")"
rm -f "$out"
gc copyfrom "$guest_out" "$out" >/dev/null
echo "[render-quorum] collected VM sign-off -> $out" >&2

tmpd="$(mktemp -d)"
trap 'rm -rf "$tmpd"' EXIT
quorum_json="$tmpd/quorum.json"
ATT_PATH="$attestation" QUORUM_PATH="$quorum_json" REPO_ROOT="$repo_root" node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  const att = JSON.parse(readFileSync(process.env.ATT_PATH, "utf8"));
  const { quorumFromDoc } = await import(pathToFileURL(`${process.env.REPO_ROOT}/reviewer-workstation/sign-release-quorum.mjs`).href);
  writeFileSync(process.env.QUORUM_PATH, `${JSON.stringify(quorumFromDoc(att), null, 2)}\n`);
'

node "$repo_root/experiments/acg-reviewer/sign-off.mjs" decide \
  --verdict "$quorum_json" \
  --signoff "$out" \
  --allowlist "$repo_root/tools/collab-cli/reviewer-allowlist.json" \
  --min 1 >/dev/null

echo "[render-quorum] verified sign-off: digest matches attestation quorum and reviewer is enrolled." >&2
