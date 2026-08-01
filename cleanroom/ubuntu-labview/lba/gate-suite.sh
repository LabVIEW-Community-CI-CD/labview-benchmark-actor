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
