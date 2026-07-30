#!/usr/bin/env bash
# provision-lbabus-fromsource.sh — set up lbabus BUILD-FROM-SOURCE on the Ubuntu golden box.
#
# Operator directive (2026-07-30): each VM builds lbabus ITSELF on first boot, from source — the ONLY path
# (no pre-built release-binary download). This script runs ONCE at provision time (needs network) and bakes:
#   - the .NET SDK, the PINNED collab-cli SOURCE (/opt/lba/src), and a VENDORED offline NuGet cache
#     (/opt/lba/nuget) that includes the linux-x64 runtime packs the self-contained build needs; plus
#   - a first-boot systemd oneshot (lba-lbabus-build.service) that publishes a self-contained SINGLE-FILE
#     `lbabus` FULLY OFFLINE from the baked source+cache into /usr/local/bin/lbabus.
# NO lbabus binary is baked: each clone (re)builds it on FIRST BOOT (ConditionPathExists=!/usr/local/bin/lbabus),
# so every VM is self-sufficient and coordinates over a binary it built itself.
#
# Replaces cleanroom/ubuntu-labview/install-lbabus.sh (which DOWNLOADED the pre-built release binary; retired
# per the build-from-source-everywhere directive). The collab-cli-v* release stays a tagged SOURCE snapshot
# for provenance/versioning, but NO consumer downloads its binary.
#
# Proven on the from-scratch VirtualBox golden box (Ubuntu 24.04.4, SDK 8.0.129): with no binary baked, a
# reboot ran the unit which rebuilt lbabus 0.11.0 (64 MB self-contained) OFFLINE from the vendored cache.
#
# Run IN the guest as root at provision time. Network is used ONLY here (SDK install + one cache warm).
set -euo pipefail
log() { echo "[lbabus-fromsource] $*"; }
[ "$(id -u)" = 0 ] || { echo "[abort] run as root:  sudo ./provision-lbabus-fromsource.sh" >&2; exit 1; }

# Extract the actor ROLE from a commit's Actor:/Agent: git trailer (the same convention lbabus agents
# --role-from-commit reads), lowercased to a dns/url-safe slug. Empty when the commit names no role.
extract_role() { # <repo> <ref>
  local r; r="$(git -C "$1" log -1 --format='%(trailers:key=Actor,valueonly)' "$2" 2>/dev/null | head -n1)"
  [ -z "$r" ] && r="$(git -C "$1" log -1 --format='%(trailers:key=Agent,valueonly)' "$2" 2>/dev/null | head -n1)"
  printf '%s' "$r" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//'
}

LBA_DIR="${LBA_DIR:-/opt/lba}"
SRC="$LBA_DIR/src"
NUGET="$LBA_DIR/nuget"
DEST="${LBABUS_DEST:-/usr/local/bin/lbabus}"
EMIT="${LBABUS_EMIT:-/usr/local/bin/emit-boot-marker.sh}"  # PATH-standard, next to lbabus; where mesh-actor.sh expects it
SDK_PKG="${DOTNET_SDK_PKG:-dotnet-sdk-8.0}"          # Ubuntu 24.04 ships this; net8.0 builds natively
REPO_URL="${LBABUS_REPO_URL:-https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor}"  # PUBLIC
REF="${LBABUS_REF:-main}"                            # pin to a tag/commit for reproducible clone builds
SRC_DIR="${LBABUS_SRC_DIR:-}"                        # optional: bake a LOCAL tools/collab-cli instead of cloning
RID="${LBABUS_RID:-linux-x64}"

export DEBIAN_FRONTEND=noninteractive DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

# 1) .NET SDK (build-time toolchain). Ubuntu 24.04's own repo provides dotnet-sdk-8.0.
if ! command -v dotnet >/dev/null 2>&1; then
  log "installing $SDK_PKG + git ..."
  apt-get update -y
  apt-get install -y --no-install-recommends "$SDK_PKG" git ca-certificates
fi
DOTNET_ROOT_DIR="$(dirname "$(readlink -f "$(command -v dotnet)")")"
log "dotnet $(dotnet --version) (root $DOTNET_ROOT_DIR)"

# 2) Bake the PINNED collab-cli source into /opt/lba/src.
rm -rf "$LBA_DIR"; mkdir -p "$SRC"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/LbaBus.csproj" ]; then
  log "baking source from local $SRC_DIR"
  cp -r "$SRC_DIR/." "$SRC"/
  COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo local)"
  ROLE="$(extract_role "$SRC_DIR" HEAD 2>/dev/null || true)"
else
  log "cloning $REPO_URL @ $REF (public; no token) ..."
  tmp="$(mktemp -d)"
  git clone "$REPO_URL" "$tmp/repo" >/dev/null 2>&1
  git -C "$tmp/repo" checkout -q "$REF"
  cp -r "$tmp/repo/tools/collab-cli/." "$SRC"/
  COMMIT="$(git -C "$tmp/repo" rev-parse HEAD)"
  ROLE="$(extract_role "$tmp/repo" HEAD 2>/dev/null || true)"
  rm -rf "$tmp"
fi
rm -rf "$SRC"/obj "$SRC"/bin "$SRC"/ci/obj "$SRC"/ci/bin 2>/dev/null || true
echo "$COMMIT" > "$LBA_DIR/SOURCE_COMMIT"
printf '%s' "${ROLE:-}" > "$LBA_DIR/SOURCE_ROLE"
[ -n "${ROLE:-}" ] && log "source commit names actor role: $ROLE" || log "source commit names no actor role (base brief)"

# 3) Warm the VENDORED NuGet cache ONLINE with the EXACT first-boot build command, so single-file build deps
#    (e.g. Microsoft.NET.ILLink.Tasks) + the linux-x64 runtime packs land in the cache. No offline NuGet.config
#    yet -> the default nuget.org source is used here (the ONLY network step for lbabus).
log "warming vendored NuGet cache (online, single-file self-contained publish) ..."
HOME="$LBA_DIR/home" DOTNET_CLI_HOME="$LBA_DIR/home" NUGET_PACKAGES="$NUGET" \
  dotnet publish "$SRC/LbaBus.csproj" -c Release -r "$RID" --self-contained \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$LBA_DIR/warm-throwaway"
rm -rf "$LBA_DIR/warm-throwaway" "$SRC"/obj "$SRC"/bin "$LBA_DIR/home"
log "vendored cache: $(du -sh "$NUGET" | cut -f1)"

# 4) OFFLINE NuGet config in the source: clear remote sources; resolve ONLY from the vendored cache.
cat > "$SRC/NuGet.config" <<XML
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources><clear/></packageSources>
  <fallbackPackageFolders><clear/><add key="lba" value="$NUGET"/></fallbackPackageFolders>
</configuration>
XML

# 5) First-boot build script (offline). systemd gives a minimal env, so HOME/DOTNET_ROOT/PATH are set here
#    (NuGet fails without HOME; dotnet needs its root on PATH).
cat > "$LBA_DIR/build-lbabus.sh" <<SH
#!/usr/bin/env bash
# Build lbabus from the baked source using the vendored OFFLINE cache -> $DEST. No network.
set -euo pipefail
export HOME=$LBA_DIR/home DOTNET_CLI_HOME=$LBA_DIR/home
export DOTNET_ROOT=$DOTNET_ROOT_DIR PATH="$DOTNET_ROOT_DIR:/usr/bin:/usr/local/bin:\$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
mkdir -p "\$HOME"
[ -x "$DEST" ] && { echo "lbabus already present at $DEST"; exit 0; }
out=\$(mktemp -d); trap 'rm -rf "\$out"' EXIT
echo "building lbabus from $SRC (offline self-contained single-file)..."
NUGET_PACKAGES="\$out/nuget" dotnet publish "$SRC/LbaBus.csproj" -c Release -r $RID --self-contained \\
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "\$out/pub"
install -m0755 "\$out/pub/lbabus" "$DEST"
"$DEST" version && echo "lbabus built -> $DEST"
# Materialize this actor's brief: the pinned base PLUS the role overlay named by the source commit's Actor:
# trailer (SOURCE_ROLE, baked at provision). Base-only when the commit named no role. Best-effort.
_role="\$(cat $LBA_DIR/SOURCE_ROLE 2>/dev/null || true)"
if [ -n "\$_role" ]; then
  "$DEST" agents --role "\$_role" --out $LBA_DIR/AGENTS.md >/dev/null 2>&1 && echo "role brief (\$_role) -> $LBA_DIR/AGENTS.md" || true
else
  "$DEST" agents --out $LBA_DIR/AGENTS.md >/dev/null 2>&1 || true
fi
SH
chmod +x "$LBA_DIR/build-lbabus.sh"

# 5b) boot-benchmark milestone emit helper (best-effort; contract: experiments/mprr-boot-benchmark/
#     emit-boot-marker.sh). Writes ONE marker per milestone to journald (`logger -t lbabench` -> the
#     authoritative guest CLOCK_MONOTONIC via `journalctl -o short-monotonic`) AND to the serial console
#     (the live host frame-pin). The serial write is `[ -w /dev/ttyS0 ]`-guarded, so it is a silent no-op
#     off-bench. The build/boot units call it via best-effort (`-`) Exec lines, so a failed or absent emit
#     NEVER perturbs the proven boot path. Quoted heredoc: the body is written verbatim (expands in-guest).
#     Installed at /usr/local/bin/emit-boot-marker.sh (PATH-standard, next to lbabus) so BOTH planes' units
#     AND WIN's mesh-actor.sh MESH-OK drop-in resolve the SAME path.
cat > "$EMIT" <<'EMITSH'
#!/usr/bin/env bash
# boot-benchmark milestone emit (contract: experiments/mprr-boot-benchmark/emit-boot-marker.sh).
set -u
CASE_ID="${1:?usage: emit-boot-marker.sh <caseId>}"
case "$CASE_ID" in BOOT-START|LBABUS-BUILD-START|LBABUS-BUILT|MESH-OK) : ;; *) echo "emit-boot-marker: unknown caseId '$CASE_ID'" >&2; exit 2 ;; esac
MONO="$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)"
LINE="LBABENCH ${CASE_ID} mono=${MONO}"
command -v logger >/dev/null 2>&1 && logger -t lbabench -- "${LINE}" || true
[ -w /dev/ttyS0 ] && printf '%s\n' "${LINE}" > /dev/ttyS0 2>/dev/null || true
exit 0
EMITSH
chmod +x "$EMIT"

# 6) First-boot systemd oneshot: runs only when the binary is absent (once per clone).
cat > /etc/systemd/system/lba-lbabus-build.service <<UNIT
[Unit]
Description=Build lbabus from source on first boot (offline self-contained)
ConditionPathExists=!$DEST
After=local-fs.target
[Service]
Type=oneshot
ExecStartPre=-$EMIT LBABUS-BUILD-START
ExecStart=$LBA_DIR/build-lbabus.sh
ExecStartPost=-$EMIT LBABUS-BUILT
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT

# 6b) BOOT-START marker oneshot: fires early (before the build unit) EVERY boot, best-effort. Unconditional
#     (no ConditionPathExists) so a from-source FIRST boot AND a later boot both anchor BOOT-START.
cat > /etc/systemd/system/lba-boot-marker.service <<UNIT
[Unit]
Description=Emit boot-benchmark BOOT-START marker (best-effort)
After=local-fs.target
Before=lba-lbabus-build.service
[Service]
Type=oneshot
ExecStart=-$EMIT BOOT-START
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable lba-lbabus-build.service lba-boot-marker.service >/dev/null 2>&1 || true

# 7) Model B: NO baked binary — each clone builds on first boot.
rm -f "$DEST"
log "DONE — lbabus builds from source (pinned ${COMMIT:0:12}) on first boot; no binary baked."
log "     first boot runs lba-lbabus-build.service -> $DEST (offline). Test now: systemctl start lba-lbabus-build.service"
