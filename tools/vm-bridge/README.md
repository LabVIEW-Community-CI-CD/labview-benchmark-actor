# VM Bridge — the agent drives the golden VM, the human types the secrets

`vm-bridge.sh` is a **human-assisted shared terminal** to the golden VM
(LBA-REQ-045, ADR-0032). It exists so an automation agent can drive the VM's
interactive shell end-to-end while a **human supplies any secret** (LabVIEW NI
sign-in, vipm.io login / VIPM activation, `sudo` passwords) **directly on the VM**
— credentials never transit the agent or the model.

## How it works

The bridge is a `tmux` session that **lives on the VM** (installed there with
`actor`'s passwordless sudo — no host `tmux`/sudo required). The agent talks to it
over SSH with `tmux send-keys` / `capture-pane`; the human attaches to the *same*
session to watch and type.

```
        agent (host)                          human (any terminal)
   vm-bridge.sh run/send/read  ── ssh ─┐   ┌─ ssh -t … tmux attach -t vmbridge
                                       ▼   ▼
                          ┌─────────────────────────────┐
                          │  tmux 'vmbridge' ON THE VM   │  ← shared live shell
                          └─────────────────────────────┘
```

## Agent commands

```bash
tools/vm-bridge/vm-bridge.sh up            # ensure tmux on the VM + create the shared session
tools/vm-bridge/vm-bridge.sh run  "<cmd>"  # run a command, wait, print its output (+ exit code)
tools/vm-bridge/vm-bridge.sh send "<cmd>"  # type a command + Enter, do NOT wait
tools/vm-bridge/vm-bridge.sh keys C-c      # send raw tmux key(s): C-c, Enter, Up, …
tools/vm-bridge/vm-bridge.sh read [N]      # print the last N lines of the shared pane
tools/vm-bridge/vm-bridge.sh secret?       # detect a password/token prompt → hand off to the human
tools/vm-bridge/vm-bridge.sh status | down
```

## Human hand-off (typing a secret)

When the agent hits a credential prompt, `secret?` exits `42` and prints the
attach command. Run it in your **own** terminal, type the secret, then detach
(`Ctrl-b` `d`) — the agent keeps driving the same session:

```bash
ssh -t -i ~/.ssh/lba_scratch -p 2222 actor@127.0.0.1 tmux attach -t vmbridge
```

## Security model

The bridge only relays keystrokes the human types themselves. It has **no** way to
ingest a credential — no `--password`/`--token` flag, no `read -s`, no `sshpass`,
no credential env var. This is enforced by the `vm-bridge-human-assisted-secret-safety`
gate (`experiments/vm-bridge/verify-vm-bridge.selftest.mjs`), which fails closed if
the bridge could take a secret or if the receipt shows the agent answered a prompt.

## Config (env; defaults target the golden scratch VM)

`VM_BRIDGE_SESSION=vmbridge` · `VM_SSH_KEY=~/.ssh/lba_scratch` · `VM_SSH_PORT=2222`
· `VM_SSH_USER=actor` · `VM_SSH_HOST=127.0.0.1`
