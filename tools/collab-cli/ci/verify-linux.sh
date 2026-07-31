#!/usr/bin/env bash
# lbabus LINUX verification suite -- Linux-container parity of tools/collab-cli/ci/verify-windows.ps1.
#
# Runs the lbabus CLI through the cross-plane-meaningful gates, adapted to a Linux container:
#   - version    : the CLI runs on Linux and reports its pinned SemVer.
#   - ci-stress  : the cross-process resource-lease mutual-exclusion regression gate (LBABUS #15/#18).
#   - ci-agents  : `lbabus agents` embed round-trips (--out then --check exit 0) and drift is detected.
#   - ci-docs    : embed round-trip + drift detection for the `lbabus docs` bundle (guide + srs + rtm).
#   - ci-harness : the in-container GitHub mock + declarative case runner (cases/*.json). ripgrep is
#                  absent here, so requiresRipgrep cases SKIP (the ci-no-rg equivalent) while the
#                  mock-requiring version-guard / defect cases RUN.
#
# Every gate is inspected via its process exit code; a failure is recorded and the script exits 1 AFTER
# running them all (so one run surfaces the full picture). Used BOTH as a build-time RUN gate in
# Dockerfile.linux AND as the image ENTRYPOINT, so `docker run <image>` re-verifies lbabus on Linux.
# LEAN by design: NO NI LabVIEW ISO/feed -- just the .NET toolchain that builds and exercises lbabus.
set -u

OUT=/out
REPO=/repo
STRESS_AGENTS=16
STRESS_ROUNDS=30
MOCK_PORT=8099
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --stress-agents) STRESS_AGENTS="$2"; shift 2 ;;
    --stress-rounds) STRESS_ROUNDS="$2"; shift 2 ;;
    --mock-port) MOCK_PORT="$2"; shift 2 ;;
    *) echo "verify-linux: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cli="$OUT/cli/lbabus.dll"
stress="$OUT/stress/lbabus-stress.dll"
mock="$OUT/mock/lbabus-mock.dll"
runner="$OUT/ci/lbabus-ci.dll"
tmp="$(mktemp -d)"
failures=""

gate() {
  # gate <name> <cmd...> -- runs the command, records a failure on non-zero, never aborts the suite.
  name="$1"; shift
  echo; echo "== $name =="
  if "$@"; then
    echo "OK: $name"
  else
    rc=$?
    echo "FAIL: $name (exit $rc)" >&2
    failures="$failures $name"
  fi
}

gate 'version' dotnet "$cli" version

gate 'ci-stress (cross-process lease mutual-exclusion)' \
  dotnet "$stress" --lbabus "$cli" --agents "$STRESS_AGENTS" --rounds "$STRESS_ROUNDS"

ci_agents() {
  f="$tmp/AGENTS.md"
  dotnet "$cli" agents --out "$f" || return 1
  dotnet "$cli" agents --check "$f" || return 1
  printf '\ndrift line\n' >> "$f"
  if dotnet "$cli" agents --check "$f"; then echo "agents --check did NOT detect drift" >&2; return 1; fi
  return 0
}
gate 'ci-agents (embed round-trip + drift detection)' ci_agents

ci_docs() {
  f="$tmp/DOCS.md"
  dotnet "$cli" docs --out "$f" || return 1
  dotnet "$cli" docs --check "$f" || return 1
  printf '\ndrift line\n' >> "$f"
  if dotnet "$cli" docs --check "$f"; then echo "docs --check did NOT detect drift" >&2; return 1; fi
  # requirements bundle (srs markdown + rtm csv): each embeds, round-trips, and drift is detected --
  # so the SRS/RTM this lbabus carries stay aligned with the build, same posture as the guide above.
  for id in srs rtm; do
    g="$tmp/docs-$id.out"
    dotnet "$cli" docs show "$id" --out "$g" || return 1
    dotnet "$cli" docs show "$id" --check "$g" || return 1
    printf '\ndrift line\n' >> "$g"
    if dotnet "$cli" docs show "$id" --check "$g"; then echo "docs show $id --check did NOT detect drift" >&2; return 1; fi
  done
  return 0
}
gate 'ci-docs (embed round-trip + drift detection)' ci_docs

gate 'ci-harness (GitHub mock + declarative case runner)' \
  dotnet "$mock" run-harness --port "$MOCK_PORT" --repo-root "$REPO" --lbabus "$cli" --runner "$runner"

echo
if [ -n "$failures" ]; then
  echo "lbabus Linux verification FAILED:$failures"
  exit 1
fi
echo "lbabus Linux verification PASSED (all gates green on linux)"
exit 0
