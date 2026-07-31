#!/usr/bin/env bash
# throughput-stress.sh -- loopback throughput stress for the typed strict-serialization bus (find the ceiling).
#
# Runs ON a mesh node (loopback, to isolate the pipeline from the network): a sink (`net listen --echo --count
# M`) plus F CONCURRENT sources, each emitting PER strictly-seq'd frames + a terminal DONE to 127.0.0.1. It
# reports aggregate frames/sec and verifies ZERO loss (recv == M) -- i.e. strict serialization held at load.
#
# The design's bottleneck is per-frame `net send` PROCESS SPAWN (one lbabus process per frame), so aggregate
# throughput rises with source concurrency (which hides per-send ack latency) until the CPUs saturate -- the
# upper limit. The sink's ingest algorithm is orders of magnitude faster and is never the limit.
#
# Usage:
#   throughput-stress.sh <F> <PER> [port]   # one point: F sources x PER frames each
#   throughput-stress.sh sweep              # F = 1,2,4,8,16,32 (x30 frames each)
set -u
LBABUS="${LBABUS:-/usr/local/bin/lbabus}"
run_lbabus() { case "$LBABUS" in *.dll) dotnet "$LBABUS" "$@" ;; *) "$LBABUS" "$@" ;; esac; }

point() {
  local F=$1 PER=$2 PORT=${3:-47900}; local M=$((F * PER))
  run_lbabus net listen --tcp "$PORT" --echo --count "$M" --timeout 300 > "/tmp/tstress-$PORT.log" 2>/dev/null & local lp=$!
  sleep 2
  local t0 t1 pids=""; t0=$(date +%s.%N)
  for s in $(seq 1 "$F"); do
    ( export VIHS_COLLAB_AGENT="src$s"
      for k in $(seq 1 "$PER"); do
        run_lbabus net send --hosts 127.0.0.1 --tcp "$PORT" --session RUN --seq "$k" \
          --type PROGRESS --task stress --message p --await 1 --retries 3 --retry-ms 200 >/dev/null 2>&1
      done ) & pids="$pids $!"
  done
  for p in $pids; do wait "$p"; done
  t1=$(date +%s.%N); wait "$lp" 2>/dev/null
  local recv; recv=$(grep -c '^TCP ' "/tmp/tstress-$PORT.log" 2>/dev/null || echo 0); rm -f "/tmp/tstress-$PORT.log"
  awk -v f="$F" -v m="$M" -v r="$recv" -v a="$t0" -v b="$t1" \
    'BEGIN{dt=b-a; printf "F=%-3d M=%-6d recv=%d/%d loss=%d elapsed=%.1fs aggregate=%.1f fps\n", f,m,r,m,(m-r),dt,m/dt}'
}

if [ "${1:-}" = "sweep" ]; then
  echo "cpus=$(nproc)  lbabus=$(run_lbabus --version 2>/dev/null | head -1)"
  p=47900; for F in 1 2 4 8 16 32; do point "$F" 30 "$p"; p=$((p + 1)); done
else
  point "${1:-8}" "${2:-30}" "${3:-47900}"
fi
