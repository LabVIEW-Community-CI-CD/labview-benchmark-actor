# ADR-0036: Agent→Human Request Beacon — the agent's ask becomes an in-VM, machine-observable step

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08, "design instrumentation to detect when the operator stopped the capture … think big, be ambitious"; PR3 direction: generic reusable barrier, toast + palette commands, optional note) + agent
- Relates to: LBA-REQ-056, ADR-0035 (Handoff Beacon Protocol — parent), LBA-REQ-055 (capture-status beacon), ADR-0032 (human-assisted VM bridge), LBA-REQ-045

## Context

The **Handoff Beacon Protocol** (ADR-0035) made a human step the agent **awaits** —
`capture-status@1` (LBA-REQ-055) turned the operator's **Stop** into a machine-observable event.
But the reviewer loop is **bidirectional**: the agent also **asks the human to do things** —
"activate LabVIEW", "run the streaming VI, then Stop", "log in to VIPM". Those asks were
invisible except through the **chat**, so the agent re-asked and burned turns, and the human had
no in-context, one-click way to say "done". The first tier gave the agent an *inbox*; it had no
*outbox*.

## Decision

Add the **agent→human request beacon** — the other direction of the protocol — as a **reusable
human-step barrier** for any manual op. Two pure, gated payloads (built by
`experiments/handoff-beacon/handoffRequest.mjs`, staged into `media/`, `handoff-request` gate):

- **`agent-request@1`** `{ id, title, body, kind, createdAt }` — the agent's ask. The agent writes
  it into `globalStorage/handoff/requests/<id>.json` (host-side, via the VM bridge / a committed
  `reviewer-workstation/request-step.sh` that builds it from the same pure builder).
- **`op-done@1`** `{ id, requestId, outcome:'done'|'skipped', note, doneAt }` — the human's answer,
  written by the extension into `globalStorage/handoff/done/<id>.json`.

Flow:

- The extension **watches** `handoff/requests/` (`fs.watch` + a startup scan) and surfaces the
  **newest unanswered** request (`selectPendingRequest`, deterministic) as a VS Code
  **notification** with **"Mark step done"** (prompts an *optional note*) and **"Skip"**. Both
  actions are **also palette commands** (`labviewBenchmarkActor.markStepDone` / `.skipStep`), so
  the barrier is answerable **without a mouse** (drivable by automation + the VM bridge).
- `validateAgentRequest` / `validateOpDone` **fail closed** on a wrong schema, an empty id/title,
  or an unknown outcome; an already-answered id is never re-surfaced.
- `reviewer-workstation/request-step.sh` drops the request into the VM and runs the guest poll
  **once**, blocking until the op-done answer resolves (`done|skipped`) or a bounded timeout — the
  **one sanctioned poll**, mirroring `await-handoff.sh`.

## Consequences

- **The agent's ask is first-class.** A manual step becomes a machine-observable, in-VM event the
  agent initiates and awaits, instead of a chat relay — human assistance is orchestrated, not
  guessed. The barrier is generic: capture-stop, activation, VIPM login, any manual op.
- **Answerable by human or automation.** The toast serves a real operator; the twin palette
  commands let the agent (or a test) close the loop deterministically over the VM bridge, which is
  how this tier is live-verified.
- **Fail-closed + deterministic.** The payloads are pure, unit-tested, gated derivations; a
  `skipped` outcome + the bounded poll mean the agent never hangs on an unanswered ask.
- **Composes with the protocol.** It sits alongside the capture-status beacon under ADR-0035 and
  reuses its transport (ADR-0032). The remaining tiers — a keyless-signed reviewer **verdict**
  beacon feeding the release-agreement / ACG grid, and an `lbabus` post — ship as their own
  governed slices.
