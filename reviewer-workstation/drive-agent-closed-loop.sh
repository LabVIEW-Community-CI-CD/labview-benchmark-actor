#!/usr/bin/env bash
# drive-agent-closed-loop.sh -- the host<->VM-agent CLOSED LOOP over TCP (ADR-0003/0008; no GitHub Discussion).
#
# Composes the two halves the previous tooling left disjoint:
#   1) HOST -> VM: keyboard-inject a prompt into the reviewer VM's Copilot Chat (drive-agent-chat.sh),
#      appending a standard REPORT-BACK instruction so the VM agent replies over TCP when it finishes.
#   2) VM -> HOST: AWAIT the VM agent's DONE frame over `lbabus net` (await-agent-reply.mjs), correlated by a
#      generated task id, and print the structured reply -- closing the loop.
#
# The read-back rides `lbabus net` (bus-msg@1, TCP 7420). Guest->host over the private Vagrant network is
# already proven: experiments/provider-delegation/vm-run-evidence.json (host 10.0.2.2:7420 received a DONE
# from inside the VM). This driver is the interactive front-end for that path; the human is on the VM.
#
# The bus stays COMMS-ONLY (ADR-0003): the VM agent's DONE carries a one-line status/decision, never run data,
# images, or artifacts -- those move out-of-band (WinRM / synced folder), never over the coordination bus.
#
# Usage:
#   reviewer-workstation/drive-agent-closed-loop.sh \
#     --vm actor \
#     --prompt "Stage the ext 0.5.0 candidate, then open the benchmark trend panel" \
#     --host-ip 10.0.2.2 --tcp 7420 --timeout 600 --out /tmp/loop
#
# Env:
#   LBABUS  path to lbabus (or *.dll) used by the host awaiter (default: `lbabus` on PATH).
set -euo pipefail

vm="actor"; prompt=""; host_ip="10.0.2.2"; tcp=7420; timeout=600; out=""; task=""
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)      vm="$2";      shift 2 ;;
    --prompt)  prompt="$2";  shift 2 ;;
    --host-ip) host_ip="$2"; shift 2 ;;
    --tcp)     tcp="$2";     shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --task)    task="$2";    shift 2 ;;
    --out)     out="$2";     shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "drive-agent-closed-loop: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$prompt" ]] || { echo "drive-agent-closed-loop: --prompt is required" >&2; exit 2; }
[[ -n "$task" ]]   || task="loop-$(date +%s)"
[[ -n "$out" ]]    || out="/tmp/agent-loop-$(date +%s)"
mkdir -p "$out"
command -v node >/dev/null || { echo "drive-agent-closed-loop: node not on PATH" >&2; exit 3; }

# The exact report-back line the VM agent must run when done. It is deterministic + correlated by --task so the
# host awaiter matches THIS request and nothing else. --message is a one-line status ONLY (comms-only invariant).
report_back="lbabus net send --host ${host_ip} --tcp ${tcp} --type DONE --task ${task} --message \"<one line: what you did / your verdict>\""

# NOTE: keyboardputstring types the prompt literally, and a NEWLINE submits the chat (Enter). The full prompt
# MUST therefore stay on ONE line, or the VM agent receives a truncated, prematurely-submitted message.
full_prompt="${prompt} -- When finished, report back by running EXACTLY this in the VM terminal (a one-line --message only, no file contents/images/artifacts): ${report_back}"

echo "[drive-agent-closed-loop] vm=${vm} task=${task} host-ip=${host_ip} tcp=${tcp} timeout=${timeout}s out=${out}"

# 1) Start the host-side read-back FIRST so the listener is bound before the VM agent could reply.
node "$here/await-agent-reply.mjs" --task "$task" --tcp "$tcp" --timeout "$timeout" --out "$out/reply-receipt.json" \
  > "$out/reply.json" 2> "$out/await.log" &
awaiter=$!
sleep 2

# 2) HOST -> VM: keyboard-inject the prompt (with the report-back instruction) into the VM's Copilot Chat.
"$here/drive-agent-chat.sh" --vm "$vm" --prompt "$full_prompt" --out "$out/inject" || {
  echo "[drive-agent-closed-loop] inject failed; stopping awaiter" >&2; kill "$awaiter" 2>/dev/null || true; exit 4; }

# 3) VM -> HOST: block on the awaiter (it exits 0 iff the correlated DONE arrived within --timeout).
echo "[drive-agent-closed-loop] prompt delivered; awaiting the VM agent's DONE (task=${task}) ..."
if wait "$awaiter"; then
  echo "[drive-agent-closed-loop] LOOP CLOSED -- VM agent reply:"
  cat "$out/reply.json"
  exit 0
fi
echo "[drive-agent-closed-loop] NO correlated reply (timeout/mismatch). See $out/await.log" >&2
exit 1
