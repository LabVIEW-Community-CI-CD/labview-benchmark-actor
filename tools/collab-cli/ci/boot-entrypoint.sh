#!/usr/bin/env bash
# boot-entrypoint.sh — from-source "boot" for the container 4-milestone timing record. Mirrors the VM's
# first-boot build + mesh, minus the serial/VNC frame-pin (a container has no console): it BUILDS lbabus
# from the baked source (LBABUS-BUILD-START -> LBABUS-BUILT), then runs the mesh workload (-> MESH-OK),
# stamping each milestone with the guest CLOCK_MONOTONIC (/proc/uptime) — the SAME authoritative clock the
# VM reads via `journalctl -o short-monotonic`. So buildMs + meshFormMs are identical in KIND to the VM
# spans, produced reliably and repeatably with no hypervisor.
#
# Emits `LBABENCH <caseId> mono=<seconds.fraction>` per milestone to $LBA_BOOT_RECORD and to stdout (the
# orchestrator reads them from `docker logs`). Exit code is the mesh workload's (0 = full TCP+UDP mesh).
set -u

REC="${LBA_BOOT_RECORD:-/tmp/lba-milestones.txt}"
SRC="${LBA_SRC:-/src}"
NUGET="${LBA_NUGET:-/nuget}"
DEST="${LBA_DEST:-/usr/local/bin/lbabus}"

mono() { cut -d' ' -f1 /proc/uptime; }
mark() { local m; m="$(mono)"; echo "LBABENCH $1 mono=$m" | tee -a "$REC"; }

: > "$REC"
mark BOOT-START
mark LBABUS-BUILD-START

# Offline, deterministic build from the baked source + vendored NuGet cache (image bakes an offline
# NuGet.config resolving only from $NUGET), matching the VM's from-source first boot.
if [ ! -x "$DEST" ]; then
  if NUGET_PACKAGES="$NUGET" dotnet publish "$SRC/LbaBus.csproj" -c Release -r linux-x64 --self-contained \
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o /tmp/pub >/tmp/build.log 2>&1; then
    install -m0755 /tmp/pub/lbabus "$DEST" 2>/dev/null || cp /tmp/pub/lbabus "$DEST" 2>/dev/null || true
  else
    echo "[boot] build FAILED (tail):" >&2; tail -n 15 /tmp/build.log >&2
  fi
fi
mark LBABUS-BUILT

# Point the mesh workload at whichever build artifact exists (self-contained apphost preferred; else the dll
# via dotnet, which run_lbabus in mesh-actor.sh handles by the *.dll case).
if [ -x "$DEST" ]; then export LBABUS="$DEST"; else export LBABUS="/tmp/pub/lbabus.dll"; fi
"$LBABUS" version >/dev/null 2>&1 || dotnet /tmp/pub/lbabus.dll version >/dev/null 2>&1 || true

# Run the shared mesh workload (TCP 7420 + UDP 7421). Exits 0 on full peer coverage.
bash /mesh-actor.sh
ec=$?
[ "$ec" -eq 0 ] && mark MESH-OK

echo "== milestones =="; cat "$REC"
exit "$ec"
