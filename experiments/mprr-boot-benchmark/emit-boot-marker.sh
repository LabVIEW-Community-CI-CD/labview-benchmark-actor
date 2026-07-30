#!/usr/bin/env bash
# emit-boot-marker.sh — the SHARED guest emit helper for boot-benchmark milestone markers.
#
# Installed + called VERBATIM on BOTH planes (LINUX/VirtualBox + WIN/VMware), the same way
# provision-lbabus-fromsource.sh is verbatim on both. It emits ONE boot milestone on two channels, each
# authoritative for one thing (per the LINUX<->WIN deterministic-record design):
#
#   1. SERIAL /dev/ttyS0  = the LIVE frame-pin channel. The host recorder tails the serial sink and pins the
#      milestone to the closest-in-host-time captured frame. Written ONLY if a serial sink is attached, so it
#      is a silent no-op off-bench (a normal boot with no recorder writes nothing).
#   2. JOURNAL via `logger -t lbabench` = the AUTHORITATIVE guest-clock line. `journalctl -o short-monotonic`
#      then yields the guest CLOCK_MONOTONIC ms for the milestone. This matters especially for BOOT-START,
#      which has no pre-existing unit log line (BUILD-START/BUILT/MESH-OK also log their own unit lines, so
#      this is belt-and-suspenders for them).
#
# Wire format (parsed by serial-marker.mjs + journal-monotonic.mjs):
#     LBABENCH <caseId> mono=<seconds.fraction>
#
# Usage: emit-boot-marker.sh <caseId>     caseId in { BOOT-START, LBABUS-BUILD-START, LBABUS-BUILT, MESH-OK }
#
# Wiring (co-owned with WIN; drop-ins, NOT edits to the proven boot path until we confirm the wire shape):
#   BOOT-START          : an early oneshot (After=local-fs.target, before lba-lbabus-build.service)
#   LBABUS-BUILD-START  : lba-lbabus-build.service  ExecStartPre=  (fires as the build begins)
#   LBABUS-BUILT        : lba-lbabus-build.service  ExecStartPost= (fires after the single-file build installs)
#   MESH-OK             : the mesh unit, when it logs "MESH OK"    (WIN's lba-mesh; co-owned drop-in)
set -u

CASE_ID="${1:?usage: emit-boot-marker.sh <caseId>}"
case "$CASE_ID" in
  BOOT-START|LBABUS-BUILD-START|LBABUS-BUILT|MESH-OK) : ;;
  *) echo "emit-boot-marker: unknown caseId '$CASE_ID'" >&2; exit 2 ;;
esac

MONO="$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)"
LINE="LBABENCH ${CASE_ID} mono=${MONO}"

# Authoritative guest-clock line (journald short-monotonic reads this).
if command -v logger >/dev/null 2>&1; then logger -t lbabench -- "${LINE}" || true; fi

# Live frame-pin line — only when a serial sink is attached (off-bench = silent).
if [ -w /dev/ttyS0 ]; then printf '%s\n' "${LINE}" > /dev/ttyS0 2>/dev/null || true; fi

exit 0
