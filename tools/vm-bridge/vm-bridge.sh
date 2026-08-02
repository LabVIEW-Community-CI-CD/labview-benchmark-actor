#!/usr/bin/env bash
# vm-bridge.sh -- human-assisted shared terminal bridge to the golden VM (LBA-REQ-045, ADR-0032).
#
# WHY: agent-driven onboarding of the golden VM hits steps that need SECRETS -- LabVIEW NI sign-in,
# vipm.io login / VIPM activation, sudo passwords. Secrets must NEVER pass through the automation agent
# or the LLM. This bridge is a shared tmux session that LIVES ON THE GOLDEN VM: the agent drives the VM's
# interactive shell over SSH via `tmux send-keys` / `capture-pane`, and the HUMAN attaches to the SAME
# session to type any password / token directly on the VM. The agent detects secret prompts and hands off;
# it never reads, stores, or transmits a credential.
#
# The session persists on the VM, so the CURRENT agent, the NEXT agent, and the human all share one live
# terminal. The host side is stateless (every call is a fresh SSH) -- there is no host daemon to manage,
# and no tmux is required on the host (tmux is installed on the VM, where `actor` has passwordless sudo).
#
# Usage:
#   vm-bridge.sh up                 # ensure tmux on the VM + create the shared session       (agent)
#   vm-bridge.sh run  "<command>"   # run a command, wait for it to finish, print its output  (agent)
#   vm-bridge.sh send "<command>"   # type a command + Enter, do NOT wait                      (agent)
#   vm-bridge.sh keys C-c           # send raw tmux key(s): C-c, Enter, Up, ...                (agent)
#   vm-bridge.sh read [N]           # print the last N lines of the shared pane (default 40)   (agent)
#   vm-bridge.sh secret?            # if the pane shows a password/token prompt, say so + how to hand off
#   vm-bridge.sh attach             # print the command the HUMAN runs to attach + type secrets
#   vm-bridge.sh status | down
#
# SECURITY MODEL: this script has NO parameter that accepts a password or token; it only relays keystrokes
# the human types themselves. Credentials are entered by the human in the attached tmux pane, on the VM,
# and never touch this script, the agent, or the model. `secret?` lets the agent notice a credential prompt
# and pause for the human instead of attempting to answer it.
#
# Config (env; defaults target the golden scratch VM):
#   VM_BRIDGE_SESSION=vmbridge   VM_SSH_KEY=~/.ssh/lba_scratch   VM_SSH_PORT=2222
#   VM_SSH_USER=actor            VM_SSH_HOST=127.0.0.1
set -uo pipefail

SESSION="${VM_BRIDGE_SESSION:-vmbridge}"
KEY="${VM_SSH_KEY:-$HOME/.ssh/lba_scratch}"
PORT="${VM_SSH_PORT:-2222}"
VMUSER="${VM_SSH_USER:-actor}"
VMHOST="${VM_SSH_HOST:-127.0.0.1}"
SSH=(ssh -i "$KEY" -p "$PORT"
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
     -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10 -o BatchMode=yes
     "${VMUSER}@${VMHOST}")

_ssh() { "${SSH[@]}" "$@"; }

# Relay an arbitrary literal string into the VM-side tmux pane. Base64 over the wire keeps it quote-proof
# (no host/ssh/remote quoting can corrupt or inject). This only moves keystrokes; it never inspects them.
_type() {
  local b64; b64=$(printf '%s' "$1" | base64 | tr -d '\n')
  _ssh "d=\$(printf '%s' '$b64' | base64 -d); tmux send-keys -t '$SESSION' -l -- \"\$d\""
}

case "${1:-help}" in
  up)
    _ssh "command -v tmux >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq tmux >/dev/null 2>&1; }
          tmux has-session -t '$SESSION' 2>/dev/null || tmux new-session -d -s '$SESSION' -x 220 -y 50
          echo \"bridge '$SESSION' up on \$(hostname) as \$(whoami)\""
    ;;
  send) shift; _type "$*"; _ssh "tmux send-keys -t '$SESSION' Enter" ;;
  keys) shift; _ssh "tmux send-keys -t '$SESSION' $*" ;;
  read) shift; _ssh "tmux capture-pane -t '$SESSION' -p -S -${1:-40}" ;;
  run)
    shift
    sent="VMB${RANDOM}${RANDOM}"
    _type "$* ; echo ${sent}=\$?"; _ssh "tmux send-keys -t '$SESSION' Enter"
    for _ in $(seq 1 "${VMB_TIMEOUT:-120}"); do
      out=$(_ssh "tmux capture-pane -t '$SESSION' -p -S -400" 2>/dev/null || true)
      if printf '%s' "$out" | grep -qE "^${sent}=[0-9]"; then
        printf '%s\n' "$out" | grep -vE "${sent}=" | tail -n "${VMB_LINES:-60}"
        code=$(printf '%s' "$out" | grep -oE "^${sent}=[0-9]+" | tail -1 | cut -d= -f2)
        echo "[vm-bridge] exit=$code"
        exit "${code:-0}"
      fi
      sleep 1
    done
    echo "[vm-bridge] TIMEOUT waiting for command to finish"
    _ssh "tmux capture-pane -t '$SESSION' -p -S -40"
    exit 124
    ;;
  secret?)
    pane=$(_ssh "tmux capture-pane -t '$SESSION' -p -S -8" 2>/dev/null || true)
    if printf '%s' "$pane" | grep -qiE 'password:|passphrase|enter.*(token|code)|sign[- ]?in|authenticat'; then
      echo "SECRET PROMPT DETECTED -- hand off to the human (do NOT answer it as the agent):"
      "$0" attach
      exit 42
    fi
    echo "no secret prompt visible"; exit 0
    ;;
  attach)
    echo "HUMAN: run this in your OWN terminal to watch the session and type any password / token"
    echo "directly on the VM (the agent keeps driving the same shared session):"
    # StrictHostKeyChecking=no + a throwaway known-hosts file so the attach still works when the VM behind
    # this host:port changes (e.g. two VMs sharing a NAT-forwarded port) -- otherwise ssh aborts with
    # "Host key verification failed" and the human can never attach.
    echo "  ssh -t -i $KEY -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${VMUSER}@${VMHOST} tmux attach -t $SESSION"
    echo "(detach without stopping anything: press Ctrl-b then d)"
    ;;
  status) _ssh "tmux has-session -t '$SESSION' 2>/dev/null && { echo UP; tmux capture-pane -t '$SESSION' -p -S -3; } || echo DOWN" ;;
  down)   _ssh "tmux kill-session -t '$SESSION' 2>/dev/null && echo 'bridge down' || echo 'no session'" ;;
  *) sed -n '2,37p' "$0" ;;
esac
