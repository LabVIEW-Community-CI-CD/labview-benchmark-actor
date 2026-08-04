#!/usr/bin/env bash
# ACG Ubuntu witness bootstrap -- runs IN the vagrant guest (see the Vagrantfile next to this file). Produces a
# reproducible `acg-witness-bundle` for the candidate by running the SAME deterministic pipeline the native
# LINUX witness runs (NO LabVIEW: the anchors are the SwiftShader viewer render + the gate suite). The bundle +
# its source receipts land in /vagrant/out (= reviewer-workstation/witness-vm/out on the host).
set -euo pipefail

PLANE="${WITNESS_PLANE:-VAGRANT}"
REF="${WITNESS_REF:-develop}"
COMMIT="${WITNESS_COMMIT:-}"
BUNDLE=/vagrant/candidate.bundle
WORK="$HOME/lba-witness"
OUT=/vagrant/out
mkdir -p "$OUT"

log() { echo "[witness] $*"; }

[ -f "$BUNDLE" ] || { echo "[witness] FATAL: $BUNDLE missing -- the host 'bundle-candidate' trigger did not run" >&2; exit 1; }

# 1) Toolchain: node 22 (NodeSource) + git.
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y >/dev/null
sudo apt-get install -y --no-install-recommends git ca-certificates curl >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  log "installing node 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
log "node $(node --version), npm $(npm --version)"

# 2) Clone the candidate from the git bundle (auth-free; the repo is private).
rm -rf "$WORK"
git clone -b "$REF" "$BUNDLE" "$WORK" >/dev/null 2>&1 || git clone "$BUNDLE" "$WORK"
cd "$WORK"
[ -n "$COMMIT" ] && git checkout "$COMMIT" >/dev/null 2>&1
HEADSHA="$(git rev-parse HEAD)"
VERSION="$(node -p "require('./package.json').version")"
log "candidate: $REF @ $HEADSHA -> ext version $VERSION (plane=$PLANE)"

# 3) Build + the extension gate suite (verdict grounds the gate receipt).
npm ci || npm install
npm run compile
VERDICT=pass
node scripts/lba.mjs verify || VERDICT=fail
FAILN=0; [ "$VERDICT" = fail ] && FAILN=1
log "lba verify -> $VERDICT"

# 4) Deterministic screenshot render (playwright + chromium) -> screenshot-receipt-<PLANE>.json.
npm --prefix playwright install >/dev/null
( cd playwright && npx playwright install --with-deps chromium >/dev/null )
LBA_PLANE="$PLANE" node playwright/screenshot.mjs

# 5) Hardware-capability probe (os inference -> linux).
node experiments/hardware-capability/probe-hardware.mjs --out "$OUT/capability-$PLANE.json" >/dev/null

# 6) Gate receipt (cleanroom-gate-suite-receipt-v1; version+sourceCommit name the EXTENSION candidate the
#    composite binds to). Grounded in the real verify verdict above.
cat > "$OUT/gate-$PLANE.json" <<JSON
{
  "schema": "labview-benchmark-actor/cleanroom-gate-suite-receipt-v1",
  "verdict": "$VERDICT",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)",
  "component": "extension",
  "lbabus": { "path": "node scripts/lba.mjs verify", "version": "$VERSION", "sourceCommit": "$HEADSHA", "sourceRole": "extension-candidate" },
  "suite": "extension release gate suite (node scripts/lba.mjs verify) on the vagrant Ubuntu witness ($PLANE)",
  "gatesFailed": $FAILN,
  "gates": [{ "name": "lba-verify", "ok": $([ "$VERDICT" = pass ] && echo true || echo false), "detail": "verdict=$VERDICT" }]
}
JSON

# 7) Assemble the witness bundle (fails closed on any missing anchor).
cp "playwright/screenshot-receipt-$PLANE.json" "$OUT/"
node experiments/acg-quorum/assemble-witness.mjs \
  --plane "$PLANE" \
  --gate       "$OUT/gate-$PLANE.json" \
  --screenshot "$OUT/screenshot-receipt-$PLANE.json" \
  --capability "$OUT/capability-$PLANE.json" \
  --out        "$OUT/witness-$PLANE.bundle.json"

log "witness bundle -> reviewer-workstation/witness-vm/out/witness-$PLANE.bundle.json"
echo "================ witness-$PLANE.bundle.json ================"
cat "$OUT/witness-$PLANE.bundle.json"
