#!/usr/bin/env bash
# ACG Ubuntu benchmark witness + Linux REVIEWER WORKSTATION bootstrap -- runs IN the vagrant guest. It (1) builds
# + packages the extension VSIX and installs it into VS Code on a GUI Ubuntu desktop (auto-login) so the box is a
# usable Linux reviewer workstation, and (2) runs the C# `tpd` THROUGHPUT-TO-DISK LADDER (no LabVIEW) via the
# extension's engine, emitting a throughput-ladder receipt. Real disk benchmarks VARY, so the receipt records the
# per-rung distribution; compare-ladders.mjs corroborates across witnesses within a tolerance band. Outputs land
# in /vagrant/out (= reviewer-workstation/witness-vm/out on the host).
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

# 1) Toolchain: node 22 (NodeSource) + git + gnupg (for the VS Code apt key).
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y >/dev/null
sudo apt-get install -y --no-install-recommends git ca-certificates curl gnupg >/dev/null
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

# 3) Build the extension + package the VSIX (the reviewer installs THIS into VS Code).
npm ci || npm install
npm run compile
VSIX="$OUT/labview-benchmark-actor-$VERSION-$PLANE.vsix"
npx --yes @vscode/vsce package --no-dependencies -o "$VSIX" >/dev/null 2>&1 \
  || npx --yes @vscode/vsce package -o "$VSIX" >/dev/null 2>&1 \
  || log "[warn] vsce package failed -- continuing (the ladder benchmark does not need the vsix)"
[ -f "$VSIX" ] && log "packaged $(basename "$VSIX")"

# 4) .NET SDK 8 (for the C# tpd throughput-to-disk tool) + build tpd.
if ! command -v dotnet >/dev/null 2>&1; then
  log "installing dotnet-sdk-8.0..."
  sudo apt-get install -y --no-install-recommends dotnet-sdk-8.0 >/dev/null 2>&1 \
    || { curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir "$HOME/.dotnet" >/dev/null; export PATH="$HOME/.dotnet:$PATH"; }
fi
( cd experiments/throughput-to-disk && dotnet build -c Release -o bin/rel >/dev/null )
log "tpd built (dotnet $(dotnet --version))"

# 5) THROUGHPUT-TO-DISK LADDER benchmark (best-effort reproducible; NO LabVIEW): per-rung MBps mean/stddev/CoV.
DOTNET_ROLL_FORWARD=Major node experiments/throughput-to-disk/run-ladder.mjs \
  --plane "$PLANE" --rungs "${WITNESS_RUNGS:-256M,512M,1G}" --samples "${WITNESS_SAMPLES:-3}" \
  --out "$OUT/throughput-ladder-$PLANE.json"
log "ladder receipt -> out/throughput-ladder-$PLANE.json"

# 6) Make the box a usable Linux REVIEWER WORKSTATION: VS Code + the VSIX, then a GUI Ubuntu desktop (auto-login).
if [ "${WITNESS_DESKTOP:-1}" = "1" ]; then
  sudo dpkg --configure -a >/dev/null 2>&1 || true   # heal any interrupted apt state from a prior run

  # 6a) VS Code FIRST (does not touch networking) + install the built extension into it.
  log "installing VS Code + the extension..."
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /etc/apt/keyrings/microsoft.gpg >/dev/null
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" | sudo tee /etc/apt/sources.list.d/vscode.list >/dev/null
  sudo apt-get update -y >/dev/null && sudo apt-get install -y code >/dev/null
  cp -r "$WORK" "$HOME/labview-benchmark-actor-src" 2>/dev/null || true
  [ -f "$VSIX" ] && code --install-extension "$VSIX" --force >/dev/null 2>&1 && log "installed the extension into VS Code"
  cat > "$HOME/REVIEWER-README.md" <<MD
# LBA Linux reviewer workstation ($PLANE)
Extension $VERSION @ $HEADSHA is installed in VS Code. Open ~/labview-benchmark-actor-src,
then run "LabVIEW Benchmark Actor: Run Throughput-to-Disk Ladder" (Ctrl+Shift+P) to exercise
the Linux benchmark path. Compare two witnesses with experiments/acg-quorum/compare-ladders.mjs.
MD

  # 6b) A LIGHT desktop (xfce4 + lightdm) -- deliberately NOT ubuntu-desktop, which pulls NetworkManager and
  #     switches netplan's renderer, reconfiguring the NAT interface mid-apt and dropping the provisioner SSH.
  #     xfce4 with --no-install-recommends pulls NO NetworkManager, so systemd-networkd (and SSH) stay intact.
  log "installing the xfce4 desktop + lightdm (auto-login; the long part)..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xorg xfce4 xfce4-terminal xfce4-session lightdm lightdm-gtk-greeter dbus-x11 >/dev/null
  sudo groupadd -f autologin && sudo gpasswd -a vagrant autologin >/dev/null 2>&1 || true
  sudo install -d /etc/lightdm/lightdm.conf.d
  sudo bash -c 'printf "[Seat:*]\nautologin-user=vagrant\nautologin-user-timeout=0\nautologin-session=xfce\nuser-session=xfce\n" > /etc/lightdm/lightdm.conf.d/50-lba-autologin.conf'
  sudo systemctl set-default graphical.target >/dev/null
  sudo systemctl start lightdm >/dev/null 2>&1 || true
  log "xfce4 desktop + lightdm installed (auto-login vagrant); the GUI appears in the VM window."
fi

log "DONE ($PLANE): throughput-to-disk ladder benchmark complete -- summary below (full data in the receipt JSON)."
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log("");
console.log("  ============ THROUGHPUT-TO-DISK LADDER: " + r.plane + " ============");
console.log("  host " + r.host + " | dotnet " + r.dotnet + " | " + r.samplesPerRung + " samples/rung (+" + r.warmupPerRung + " warm-up)");
console.log("  " + pad("rung", 7) + padl("mean MBps", 11) + padl("stddev", 9) + padl("CoV%", 7) + "   samples");
for (const x of r.rungs) console.log("  " + pad(x.bytes, 7) + padl(x.meanMbps, 11) + padl(x.stddevMbps, 9) + padl(x.covPct, 7) + "   [" + x.samplesMbps.join(", ") + "]");
console.log("  mean across rungs: " + r.summary.meanMbps + " MBps (min " + r.summary.minMbps + ", max " + r.summary.maxMbps + ")");
console.log("  receipt: reviewer-workstation/witness-vm/out/throughput-ladder-" + r.plane + ".json");
console.log("  corroborate 2 witnesses: node experiments/acg-quorum/compare-ladders.mjs out/throughput-ladder-<A>.json out/throughput-ladder-<B>.json");
console.log("");
' "$OUT/throughput-ladder-$PLANE.json"
