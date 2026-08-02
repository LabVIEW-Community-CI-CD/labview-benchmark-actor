# ADR-0032: Human-assisted VM bridge — the agent drives the golden VM, the human types the secrets

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08-02, "establish a VM bridge so you and the next agent can type directly on the VM terminal while the human assists with passwords") + agent
- Relates to: LBA-REQ-045, ADR-0023 (personal golden-VM onboarding), LBA-REQ-033 (`lba init`), LBA-REQ-044 (provisioner installs LabVIEW + VIPM)

## Context

Agent-driven onboarding of the golden VM (ADR-0023) repeatedly hits steps that
require **secrets**: LabVIEW activation (NI sign-in), VIPM activation (vipm.io
login), and `sudo` passwords on hosts without passwordless sudo. These secrets
must **never** pass through the automation agent or the LLM. One-shot SSH commands
cannot service an interactive credential prompt, and feeding secrets to the agent
(env vars, `sshpass`, `--password` flags, `read -s`) is exactly the anti-pattern
to forbid. What was missing was a way for the agent to drive the VM's interactive
shell *and* let the human supply a credential in-band, at the moment it is asked
for, without the agent ever seeing it.

## Decision

- Provide a **shared `tmux` session that lives on the golden VM** (`vm-bridge.sh`).
  The session's shell is the VM's shell; both the current agent, the next agent,
  and the human share the one live terminal.
- The **agent drives** the session over SSH with `tmux send-keys` /
  `capture-pane` (`up`, `run`, `send`, `keys`, `read`). The host side is
  stateless — no host daemon, and (deliberately) **no host `tmux`/sudo**: `tmux`
  is installed on the VM, where the `actor` user has passwordless sudo.
- The **human attaches** to the same session (`attach` prints the one SSH command)
  to type any password/token **directly on the VM**.
- The bridge is **secret-safe by construction**: it has *no* affordance to ingest
  a credential (no `--password`/`--token` flag, no `read -s`, no `sshpass`, no
  credential env var). A `secret?` command lets the agent *detect* a credential
  prompt and hand off to the human instead of answering it.
- **Gate it fail-closed** (`vm-bridge-human-assisted-secret-safety`): the committed
  bridge must expose the drive + hand-off surface and be secret-safe, and the live
  receipt must show the agent drove the VM and a real credential prompt was
  detected + handed off — never answered by the agent.

This is requirement **LBA-REQ-045**.

## Consequences

- **Human-in-the-loop provisioning is unblocked**: the agent can carry the golden
  VM through activation and any sudo/login step, pausing for the human exactly at
  the credential prompt. Proven live — the agent drove the scratch VM's shell and
  detected a real `password:` prompt (exit 42), handed off, and cancelled without
  typing a secret.
- **Credentials stay with the human**: they are typed in the attached pane, on the
  VM, and never transit the agent or the model — enforced by the gate, not just by
  convention.
- The bridge generalizes to any VM (SSH target is env-configurable) and is the
  natural substrate for the `lba init` orchestrator (LBA-REQ-033) and for VIPM /
  LabVIEW activation on the golden VM.
