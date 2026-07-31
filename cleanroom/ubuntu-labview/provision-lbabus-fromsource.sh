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

# 5c) Gate-suite runner: self-certifies the freshly built lbabus with the OFFLINE, binary-only subset of
#     tools/collab-cli/ci/verify-linux.sh (the gates that need NOTHING but the built single-file binary --
#     no mock, no port, no extra .NET project build, no network, no ripgrep): version + the agents/docs
#     embed round-trip + drift-detection gates. Writes a durable JSON receipt (evidence) and, when the
#     operator wires an observer (LBA_GATE_BEACON_HOSTS), beacons the verdict over the lbabus bus. Quoted
#     heredoc: written verbatim; DEST/LBA_DIR arrive via the unit's Environment= (set below).
cat > "$LBA_DIR/gate-suite.sh" <<'GATESH'
#!/usr/bin/env bash
# gate-suite.sh -- first-boot CI for the cleanroom: run the offline, binary-only lbabus gate suite against
# the freshly built binary and record a receipt. Exit 0 iff every gate passes. The receipt is always
# written (the verdict lives inside), so a failure is durable evidence rather than a silent boot.
set -u

LBABUS="${LBABUS:-/usr/local/bin/lbabus}"
LBA_DIR="${LBA_DIR:-/opt/lba}"
RECEIPT="${LBA_GATE_RECEIPT:-$LBA_DIR/gate-suite-receipt.json}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

log() { echo "[gate-suite] $*"; logger -t lbabench-gate -- "$*" 2>/dev/null || true; }

results_json=""
failures=0
gate() { # gate <name> <fn...>
  local name="$1"; shift
  local rc=0
  echo; echo "== $name =="
  if "$@"; then log "OK: $name"; else rc=$?; log "FAIL: $name (exit $rc)"; failures=$((failures + 1)); fi
  local status; [ "$rc" = 0 ] && status="pass" || status="fail"
  results_json="${results_json:+$results_json,}$(printf '{"gate":"%s","status":"%s","exitCode":%s}' "$name" "$status" "$rc")"
}

g_version() { "$LBABUS" version; }

# agents embed round-trips (--out then --check exit 0), and drift is DETECTED (a mutated file --check fails).
g_agents() {
  local f="$TMP/AGENTS.md"
  "$LBABUS" agents --out "$f" || return 1
  "$LBABUS" agents --check "$f" || return 1
  printf '\ndrift line\n' >> "$f"
  if "$LBABUS" agents --check "$f"; then echo "agents --check did NOT detect drift" >&2; return 1; fi
  return 0
}

# docs bundle (guide) + the requirements bundle (srs markdown + rtm csv): each embeds, round-trips, drifts.
g_docs() {
  local f="$TMP/DOCS.md"
  "$LBABUS" docs --out "$f" || return 1
  "$LBABUS" docs --check "$f" || return 1
  printf '\ndrift line\n' >> "$f"
  if "$LBABUS" docs --check "$f"; then echo "docs --check did NOT detect drift" >&2; return 1; fi
  local id g
  for id in srs rtm; do
    g="$TMP/docs-$id.out"
    "$LBABUS" docs show "$id" --out "$g" || return 1
    "$LBABUS" docs show "$id" --check "$g" || return 1
    printf '\ndrift line\n' >> "$g"
    if "$LBABUS" docs show "$id" --check "$g"; then echo "docs show $id --check did NOT detect drift" >&2; return 1; fi
  done
  return 0
}

if [ -x "$LBABUS" ]; then
  gate 'version' g_version
  gate 'ci-agents (embed round-trip + drift detection)' g_agents
  gate 'ci-docs (embed round-trip + drift detection)' g_docs
else
  log "ERROR lbabus not found/executable at $LBABUS -- did lba-lbabus-build.service run?"
fi

verdict="pass"; [ "$failures" -gt 0 ] && verdict="fail"; [ -x "$LBABUS" ] || verdict="error"
ver="$("$LBABUS" version 2>/dev/null | head -n1 | tr -d '\r')"
commit="$(head -n1 "$LBA_DIR/SOURCE_COMMIT" 2>/dev/null)"
role="$(head -n1 "$LBA_DIR/SOURCE_ROLE" 2>/dev/null)"
host="$(hostname 2>/dev/null)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

mkdir -p "$LBA_DIR" 2>/dev/null || true
cat > "$RECEIPT" <<JSON
{
  "schema": "labview-benchmark-actor/cleanroom-gate-suite-receipt-v1",
  "verdict": "$verdict",
  "generatedAt": "$ts",
  "host": "$host",
  "lbabus": { "path": "$LBABUS", "version": "$ver", "sourceCommit": "$commit", "sourceRole": "$role" },
  "suite": "verify-linux binary-only subset (version + ci-agents + ci-docs)",
  "gatesFailed": $failures,
  "gates": [$results_json]
}
JSON
log "receipt -> $RECEIPT (verdict=$verdict, gatesFailed=$failures)"

# OPTIONAL, best-effort, OFF by default: announce the verdict over the lbabus bus so a UDP observer collects
# each cleanroom's CI outcome (distributed CI over TCP/UDP). Set LBA_GATE_BEACON_HOSTS=<csv peers/observer>.
# A missing/failed beacon NEVER changes the verdict; only confirmed `net beacon` flags are used.
if [ -x "$LBABUS" ] && [ -n "${LBA_GATE_BEACON_HOSTS:-}" ]; then
  "$LBABUS" net beacon --hosts "$LBA_GATE_BEACON_HOSTS" --udp "${LBA_GATE_BEACON_UDP:-7421}" \
    ${LBA_GATE_BEACON_BIND:+--bind "$LBA_GATE_BEACON_BIND"} --count 3 --interval 1 --task "gate-$verdict" \
    >/dev/null 2>&1 && log "beaconed gate-$verdict -> $LBA_GATE_BEACON_HOSTS" || log "verdict beacon best-effort no-op"
fi

[ "$verdict" = "pass" ] && exit 0 || exit 1
GATESH
chmod +x "$LBA_DIR/gate-suite.sh"

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

# 6c) Gate-suite oneshot: after the first-boot build publishes lbabus, self-certify the freshly built
#     binary with the OFFLINE binary-only gate suite (verify-linux subset: version + agents/docs embed
#     round-trip + drift) and write $LBA_DIR/gate-suite-receipt.json. Requires+After the build unit, and
#     its own ConditionPathExists=$DEST means it runs once the binary exists and re-certifies on every
#     boot. Independent of the mesh path, so a gate FAIL surfaces in `systemctl status lba-gate-suite` +
#     the receipt WITHOUT perturbing the proven boot/mesh timing milestones.
cat > /etc/systemd/system/lba-gate-suite.service <<UNIT
[Unit]
Description=Run the lbabus gate suite after first-boot build (self-certify the freshly built binary)
Requires=lba-lbabus-build.service
After=lba-lbabus-build.service
ConditionPathExists=$DEST
[Service]
Type=oneshot
Environment=LBABUS=$DEST
Environment=LBA_DIR=$LBA_DIR
ExecStart=$LBA_DIR/gate-suite.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable lba-lbabus-build.service lba-boot-marker.service lba-gate-suite.service >/dev/null 2>&1 || true

# 7) Model B: NO baked binary — each clone builds on first boot.
rm -f "$DEST"
log "DONE — lbabus builds from source (pinned ${COMMIT:0:12}) on first boot; no binary baked."
log "     first boot: lba-lbabus-build.service -> $DEST (offline), then lba-gate-suite.service self-certifies"
log "     it (version + agents/docs round-trip+drift) -> $LBA_DIR/gate-suite-receipt.json."
log "     Test now: systemctl start lba-lbabus-build.service && systemctl start lba-gate-suite.service"
log "     Then: systemctl status lba-gate-suite.service ; cat $LBA_DIR/gate-suite-receipt.json"
