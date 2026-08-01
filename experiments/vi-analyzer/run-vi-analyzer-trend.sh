#!/usr/bin/env bash
# Guest-resident VI Analyzer TREND harness (runs ON the Ubuntu cleanroom, NOT the host). Runs LabVIEWCLI
# RunVIAnalyzer N times under a headless Xvfb :99, timing each wall + saving each ASCII report + CLI output, so
# the HOST can parse each run into the v2 normalized report (parse-vi-analyzer-ascii.mjs) + a deterministic
# resultHash (viAnalyzerResult.mjs) and build a trend receipt (wall-time variance + resultHash DETERMINISM: a
# real workload run repeatedly must produce the SAME digest every time).
#
# Self-contained on purpose: explicit PATH + absolute tool paths, so it survives a detached / non-login shell
# where /usr/local/bin (the LabVIEWCLI symlink) is not on PATH -- the exact failure mode that made SSH-held
# trend runs flaky. Idempotent: clears prior artifacts each run and writes the DONE marker LAST so the host can
# poll for completion.
#
# Usage (on the guest):  bash run-vi-analyzer-trend.sh [N=6]
# Artifacts:  ~/vi-analyzer-trend/{report-NN.txt, cli-NN.txt, trend-meta.jsonl, run.log}
#             ~/vi-analyzer-trend.DONE   (ISO timestamp, written last == the completion marker)
set -u
export PATH=/usr/local/bin:/usr/local/natinst/share/nilvcli:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}
CFG=/usr/local/natinst/share/nilvcli/Examples/LabVIEWCLIExampleProject/ConfigFile.viancfg
LVPATH=/usr/local/natinst/LabVIEW-2026-64/labview
OUT="$HOME/vi-analyzer-trend"
N="${1:-6}"

rm -f "$HOME/vi-analyzer-trend.DONE"
rm -rf "$OUT"; mkdir -p "$OUT"
: > "$OUT/trend-meta.jsonl"
echo "trend start $(date -Is) N=$N host=$(hostname)" > "$OUT/run.log"

# Headless display :99 (isolated from the gdm :0 session). Start it only if not already up.
if ! pgrep -f 'Xvfb :99' >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 &
  echo "started Xvfb :99 pid=$!" >> "$OUT/run.log"
fi
export DISPLAY=:99
# Wait for the X server to actually ACCEPT connections before launching LabVIEW. A freshly-started Xvfb is not
# instantly ready, and LabVIEW SEGFAULTS if it connects to a half-initialized display -- a fixed `sleep` is a
# race that intermittently crashes the launch. Poll xdpyinfo (bounded ~30s), then a 1s settle buffer.
for _ in $(seq 1 60); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.5
done
sleep 1
echo "display :99 ready $(date -Is)" >> "$OUT/run.log"

for i in $(seq 1 "$N"); do
  ii=$(printf '%02d' "$i")
  RPT="$OUT/report-$ii.txt"
  CLI="$OUT/cli-$ii.txt"
  t0=$(date +%s%3N)
  timeout 180 LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath "$CFG" -ReportPath "$RPT" \
    -ReportSaveType ASCII -LabVIEWPath "$LVPATH" >"$CLI" 2>&1
  rc=$?
  t1=$(date +%s%3N)
  wall=$((t1 - t0))
  printf '{"run":%d,"wallMs":%d,"exit":%d,"report":"report-%s.txt","cli":"cli-%s.txt"}\n' \
    "$i" "$wall" "$rc" "$ii" "$ii" >> "$OUT/trend-meta.jsonl"
  echo "run $i wall=${wall}ms exit=$rc $(date -Is)" >> "$OUT/run.log"
done

echo "trend done $(date -Is)" >> "$OUT/run.log"
date -Is > "$HOME/vi-analyzer-trend.DONE"
