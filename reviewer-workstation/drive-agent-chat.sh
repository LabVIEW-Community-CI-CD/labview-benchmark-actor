#!/usr/bin/env bash
# drive-agent-chat.sh -- authoritative reviewer-VM Copilot Chat driver (host-side, VBoxManage).
#
# Part of the reviewer visual-pass TEST INFRASTRUCTURE. Drives the agent chat inside a running
# reviewer VM to exercise the extension's AGENT-FACING surface -- its Language Model tools and the
# bundled MCP server tools -- end to end, capturing PNG screenshot evidence at each step.
#
# This is the exact procedure that caught the `check_independence` MCP schema defect during the
# ext-0.5.0 visual pass: an `array` tool parameter declared without the required JSON-Schema
# `items`, which the VS Code tool validator rejects with "tool parameters array type must have
# items", breaking agent-mode tool use. A pure-schema regression guard now lives in
# experiments/acg-mcp/grid-tools.selftest.mjs, and this script is the live counterpart.
# See docs/testing/reviewer-manual-test-plan.md TC-11.
#
# Preconditions (see reviewer-workstation/README.md):
#   * The reviewer VM is booted and logged in, with VS Code open and the extension installed.
#   * The Copilot Chat view is available (Agent mode). It may be open or closed; step 1 starts a FRESH
#     chat session via the Command Palette (which also focuses the input) so the drive never submits into
#     a restored/errored historical session -- deterministic clean slate, NOT the stateful Ctrl+Alt+I toggle.
#   * `VBoxManage` is on the host PATH. No guest credentials are needed for the drive itself --
#     keystrokes and screenshots travel over the VirtualBox console channel.
#
# Usage:
#   reviewer-workstation/drive-agent-chat.sh \
#     --vm actor \
#     --prompt "Open the resource profile benchmark panel" \
#     --out /tmp/agent-chat
#
# Exit status is 0 when the drive completes. INSPECT the screenshots in --out to judge PASS/FAIL:
# a PASS shows the requested panel/tool result with NO "tool ... must have items" or other
# tool-validation error in the chat transcript.
set -euo pipefail

vm="actor"
prompt=""
out=""
settle="${LBA_CHAT_SETTLE:-3}"      # seconds to let VS Code process a keystroke burst
answer="${LBA_CHAT_ANSWER:-25}"     # seconds to let the agent produce a response
# The palette command that prepares a live, focused chat input. Default starts a FRESH session so the
# drive never appends to a restored/errored historical session; override to continue an existing one.
focus_cmd="${LBA_CHAT_FOCUS_CMD:-Chat: New Chat}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)      vm="$2";     shift 2 ;;
    --prompt)  prompt="$2"; shift 2 ;;
    --out)     out="$2";    shift 2 ;;
    --settle)  settle="$2"; shift 2 ;;
    --answer)  answer="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "drive-agent-chat: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$prompt" ]] || { echo "drive-agent-chat: --prompt is required" >&2; exit 2; }
[[ -n "$out" ]]    || out="/tmp/agent-chat-$(date +%s)"
command -v VBoxManage >/dev/null || { echo "drive-agent-chat: VBoxManage not on PATH" >&2; exit 3; }
mkdir -p "$out"

# --- VirtualBox keyboard primitives (US layout; make/break scancode pairs) ---
kbd()  { VBoxManage controlvm "$vm" keyboardputscancode "$@" >/dev/null; }
kstr() { VBoxManage controlvm "$vm" keyboardputstring "$1" >/dev/null; }
shot() { VBoxManage controlvm "$vm" screenshotpng "$out/$1" >/dev/null && echo "  evidence: $out/$1"; }

CTRL_SHIFT_P=(1d 2a 19 99 aa 9d)   # Command Palette
ENTER=(1c 9c)
ESC=(01 81)

echo "[drive-agent-chat] vm=$vm out=$out settle=${settle}s answer=${answer}s"

# 1. Prepare a live, focused chat input via the Command Palette (default: a fresh session, non-toggling).
echo "[1/6] prepare chat input via palette: '$focus_cmd'"
kbd "${ESC[@]}"; sleep 1                    # clear any stray palette/menu first
kbd "${CTRL_SHIFT_P[@]}"; sleep "$settle"
kstr "$focus_cmd"; sleep "$settle"; shot 01-focus-cmd.png
kbd "${ENTER[@]}"; sleep "$settle"; shot 02-focused.png

# 2. Type the prompt and verify it landed BEFORE submitting.
echo "[2/6] type prompt: $prompt"
kstr "$prompt"; sleep "$settle"; shot 03-prompt.png

# 3. Submit.
echo "[3/6] submit"
kbd "${ENTER[@]}"; sleep 2; shot 04-submitted.png

# 4. Let the agent think + act, then capture the response / tool result.
echo "[4/6] await agent (${answer}s)"
sleep "$answer"; shot 05-response.png

# 5. A later frame catches a slow tool or panel finishing.
echo "[5/6] settle frame"
sleep "$settle"; shot 06-settled.png

echo "[6/6] done -- inspect the evidence:"
ls -1 "$out"
