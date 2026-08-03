# ADR-0035: Handoff Beacon Protocol — human-in-the-loop as a machine-observable signal

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08, "design instrumentation to detect when the operator stopped the capture … think big, be ambitious") + agent
- Relates to: LBA-REQ-055, ADR-0032 (human-assisted VM bridge), LBA-REQ-045 (human-assisted VM bridge), LBA-REQ-034 (26514 information for users), docs/roadmap.md

## Context

The reviewer VM exists **because some steps need a human**: activating LabVIEW, running a VI,
clicking **Stop LabVIEW Capture**, and — above all — rendering the **visual verdict** the whole
reviewer gate is for. To the agent driving the flow, those steps are **invisible** except
through the chat: it either guesses ("are you done yet?") or re-asks, which wastes turns and
makes human assistance expensive to orchestrate. Concretely, when the operator streams a VI to
disk and stops a capture, the agent had no reliable signal that the stop happened, nor a
pointer to *where in the capture the interesting thing occurred*.

## Decision

Introduce the **Handoff Beacon Protocol** — human-in-the-loop steps become small,
machine-readable **beacons** (JSON) the agent can **await** and act on, and the agent's asks
become prompts the human sees **in-context**. Beacons live in the extension's `globalStorage`
(capture beacons in the capture run dir), and are polled **host-side** (the one sanctioned poll
in the flow) by a committed script that runs **once** and blocks until the beacon resolves.

The **first instance** is the **capture-status beacon** (`capture-status@1`, LBA-REQ-055):

- The extension writes `capture-status.json` at capture **START** (`state:'capturing'`) and
  **STOP** (`state:'stopped'` with a rich payload, or `state:'failed'` on assembly error),
  best-effort so it never perturbs the capture.
- The stop payload is derived by the pure, gated `buildCaptureStatus`: `wroteToDisk` (a per-disk
  write rate above a threshold for a minimum number of samples), the **peak write MB/s + the
  frame index where it peaked** + the disk, and a **per-physical-disk write/read peak**
  breakdown — so the agent jumps straight to the evidence instead of scrubbing.
- `reviewer-workstation/await-handoff.sh` runs the guest poll once and blocks until the beacon
  resolves (`stopped|failed`) or a bounded timeout, printing the resolved payload.
- `validateCaptureStatus` fails closed on a wrong schema, an unknown state, or a stopped/failed
  beacon missing its payload; the builder + self-test are gated by `handoff-capture-status`.

The protocol is designed to **extend** in governed slices: an **agent→human request** beacon
(the agent's ask surfaces in the VM as a notification with a "Mark step done" button that writes
an op-done beacon), the correlator **auto-navigating** to the peak-write frame on stop, a
**reusable human-step barrier** for any manual op (activation, VIPM login), and a **keyless-signed
reviewer verdict** beacon that feeds the release-agreement / ACG grid (the human gate becomes a
witnessed artifact) — optionally posted to the `lbabus` coordination bus so remote actors see it.

## Consequences

- **Efficient human assistance.** The agent awaits the human's Stop with one bounded poll and
  resumes with the evidence in hand, instead of guessing or re-asking. The reviewer flow becomes
  a coordinated agent↔human loop, not a chat relay.
- **Fail-closed + deterministic.** The beacon payload is a pure, unit-tested, gated derivation;
  a `failed` beacon means the agent never waits forever on a broken assembly.
- **Composes, does not replace.** The beacon sits alongside the existing capture artifacts
  (`capture.json`, `resources.jsonl`); `await-handoff.sh` falls back to `capture.json` for a
  legacy capture with no beacon. The human-assisted VM bridge (ADR-0032) is the transport; this
  ADR makes the *steps* observable.
- **Roadmap.** The verdict-beacon tier turns the reviewer's visual PASS/FAIL — the very thing the
  reviewer VM exists for — into a governed, timestamped, signable input to the release flow,
  closing the manual loop the operator currently runs by hand.
