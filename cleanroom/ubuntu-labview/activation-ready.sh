#!/usr/bin/env bash
# activation-ready.sh -- prepare an Ubuntu LabVIEW golden actor for the human-only NI activation step.
#
# This script never accepts, reads, or transmits NI/VIPM credentials. It checks the guest-side prerequisites
# needed before a user opens LabVIEW, and --repair may re-run the idempotent public-package provisioner.
set -eu

MODE=check
OUT=/tmp/lba-activation-readiness-capture.json
PROVISIONER=
KEYRING=
PRIMARY_USER="${PRIMARY_USER:-$(id -un)}"

usage() {
  cat <<'USAGE'
Usage:
  bash activation-ready.sh --check [--out <capture.json>]
  bash activation-ready.sh --repair --provisioner <provision-guest.sh> --keyring <ni-key.asc> [--out <capture.json>]

--repair installs public LabVIEW/VIPM prerequisites only. NI/VIPM activation remains the user's step.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --repair) MODE=repair ;;
    --out) OUT="$2"; shift ;;
    --provisioner) PROVISIONER="$2"; shift ;;
    --keyring) KEYRING="$2"; shift ;;
    --user) PRIMARY_USER="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "activation-ready: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "activation-ready: python3 is required to write the readiness capture" >&2
  exit 127
fi

repair_performed=false
if [ "$MODE" = repair ]; then
  if [ -z "$PROVISIONER" ] || [ -z "$KEYRING" ]; then
    echo "activation-ready: --repair requires --provisioner and --keyring" >&2
    exit 2
  fi
  if [ ! -f "$PROVISIONER" ] || [ ! -f "$KEYRING" ]; then
    echo "activation-ready: provisioner or keyring does not exist" >&2
    exit 2
  fi
  sudo env PRIMARY_USER="$PRIMARY_USER" NI_KEYRING="$KEYRING" "$PROVISIONER"
  repair_performed=true
fi

user_home="$(getent passwd "$PRIMARY_USER" | cut -d: -f6)"
config_dir="${user_home}/natinst/.config/LabVIEW-2026"
labview_conf="${config_dir}/labview.conf"
community_conf="${config_dir}/labviewcommunity.conf"

has_command() { command -v "$1" >/dev/null 2>&1; }
file_contains() { [ -f "$1" ] && grep -Fq "$2" "$1"; }

check_labview_cli=false; has_command LabVIEWCLI && check_labview_cli=true
check_labview_binary=false; [ -x /usr/local/natinst/LabVIEW-2026-64/labview ] && check_labview_binary=true
check_probe_vi=false; [ -f /usr/local/natinst/share/nilvcli/Examples/AddTwoNumbers/AddTwoNumbers.vi ] && check_probe_vi=true
check_python=false; has_command python3 && check_python=true
check_xvfb=false; has_command Xvfb && check_xvfb=true
check_xdpyinfo=false; has_command xdpyinfo && check_xdpyinfo=true
check_vipm_package=false; dpkg -s vipm >/dev/null 2>&1 && check_vipm_package=true
check_vipm_command=false; has_command vipm && check_vipm_command=true
check_labview_conf=false; [ -f "$labview_conf" ] && check_labview_conf=true
check_community_conf=false; [ -f "$community_conf" ] && check_community_conf=true
check_vi_server_tcp=false
check_vi_server_access=false
if file_contains "$labview_conf" 'server.tcp.enabled=TRUE' && file_contains "$labview_conf" 'server.tcp.port=3363' && \
   file_contains "$community_conf" 'server.tcp.enabled=TRUE' && file_contains "$community_conf" 'server.tcp.port=3363'; then
  check_vi_server_tcp=true
fi
if file_contains "$labview_conf" 'server.tcp.access="' && file_contains "$labview_conf" 'server.vi.access="' && \
   file_contains "$community_conf" 'server.tcp.access="' && file_contains "$community_conf" 'server.vi.access="'; then
  check_vi_server_access=true
fi
check_sudo=false; sudo -n true >/dev/null 2>&1 && check_sudo=true

python3 - "$OUT" "$MODE" "$repair_performed" "$PRIMARY_USER" \
  "$check_labview_cli" "$check_labview_binary" "$check_probe_vi" "$check_python" "$check_xvfb" "$check_xdpyinfo" \
  "$check_vipm_package" "$check_vipm_command" "$check_labview_conf" "$check_community_conf" "$check_vi_server_tcp" "$check_vi_server_access" "$check_sudo" <<'PY'
import json
import socket
import sys

(
    destination, mode, repaired, user,
    labview_cli, labview_binary, probe_vi, python3, xvfb, xdpyinfo,
    vipm_package, vipm_command, labview_conf, community_conf, vi_server_tcp, vi_server_access, sudo_ready,
) = sys.argv[1:]

def as_bool(value):
    return value == "true"

checks = {
    "labviewCli": as_bool(labview_cli),
    "labviewBinary": as_bool(labview_binary),
    "probeVi": as_bool(probe_vi),
    "python3": as_bool(python3),
    "xvfb": as_bool(xvfb),
    "xdpyinfo": as_bool(xdpyinfo),
    "vipmPackage": as_bool(vipm_package),
    "vipmCommand": as_bool(vipm_command),
    "labviewConf": as_bool(labview_conf),
    "labviewCommunityConf": as_bool(community_conf),
    "viServerTcp": as_bool(vi_server_tcp),
    "viServerAccess": as_bool(vi_server_access),
    "passwordlessSudo": as_bool(sudo_ready),
}
missing = [name for name, present in checks.items() if not present]
record = {
    "schema": "labview-benchmark-actor/golden-activation-readiness-capture@1",
    "mode": mode,
    "repairPerformed": as_bool(repaired),
    "rebootRequired": mode == "repair",
    "guest": {"hostname": socket.gethostname(), "user": user},
    "checks": checks,
    "missing": missing,
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY

if [ "$repair_performed" = true ]; then
  echo "activation readiness repair complete; reboot once before LabVIEW activation so VI Server binds cleanly"
fi
if [ "$check_labview_cli" = true ] && [ "$check_labview_binary" = true ] && [ "$check_probe_vi" = true ] && \
   [ "$check_python" = true ] && [ "$check_xvfb" = true ] && [ "$check_xdpyinfo" = true ] && \
   [ "$check_vipm_package" = true ] && [ "$check_vipm_command" = true ] && [ "$check_labview_conf" = true ] && \
   [ "$check_community_conf" = true ] && [ "$check_vi_server_tcp" = true ] && [ "$check_vi_server_access" = true ] && \
   [ "$check_sudo" = true ]; then
  echo "activation readiness capture -> $OUT (READY)"
  exit 0
fi

echo "activation readiness capture -> $OUT (INCOMPLETE)" >&2
exit 1
