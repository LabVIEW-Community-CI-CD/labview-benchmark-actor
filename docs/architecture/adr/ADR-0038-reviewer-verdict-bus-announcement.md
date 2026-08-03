# ADR-0038: Reviewer Verdict Bus Announcement — the signed verdict reaches the coordination bus

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08, PR5 direction: semantic bus type by verdict; the extension posts from the VM + auto in release CI; the full signed verdict JSON is the payload) + agent
- Relates to: LBA-REQ-058, ADR-0035 (Handoff Beacon Protocol — parent), ADR-0037 (reviewer visual verdict), LBA-REQ-057, ADR-0032 (human-assisted VM bridge), experiments/provider-delegation/busFrame.mjs, tools/collab-cli (lbabus)

> **Superseded in part (ADR-0044, LBA-REQ-064):** the release-CI GitHub-Discussion announce step was removed
> under the live-only net model. The verdict is still announced by the extension + `post-verdict.mjs` (now
> net-capable, ADR-0041/0043); the durable record is the committed signed verdict.

## Context

ADR-0037 made the reviewer's visual PASS/FAIL a signed, gate-verifiable artifact — but it stayed
**local** (a file in `handoff/verdicts/` and the release-agreement). The `lbabus` coordination bus
(a GitHub Discussion the WIN and LINUX planes read) is how the actors coordinate; a remote actor
had **no way to see** that a human had reviewed and PASSED (or blocked) a release candidate. The
Handoff Beacon Protocol's final tier closes that: the reviewer's verdict becomes a **coordination
event**, not just a local record.

## Decision

Announce a signed reviewer verdict on the `lbabus` bus (`buildVerdictBusPost`, added to the pure,
staged, gated `reviewerVerdict.mjs`):

- **Semantic message type by verdict** — a `pass` posts as **RESOLVED**, `changes` as **REFINE**,
  `fail` as **BLOCKED** — so a remote actor gets an **actionable** signal, not a bare FYI. The post
  targets the release task (`<component>-release-<version>`) at the candidate `ref` (commit).
- **The FULL signed verdict JSON is the message body** (`lbabus post … --message-file <verdict>`),
  so the bus carries the verifiable artifact (the `acg-human-signoff-v1` + the `reviewer-verdict@1`),
  not just a summary.
- **Two posting paths, one builder.** The **extension** posts from the reviewer VM immediately after
  it signs (best-effort — a missing `lbabus` / GH token is logged, never thrown into signing), and
  the **release CI** posts automatically after `verify-visual-review` passes (`post-verdict.mjs` +
  `dotnet run … lbabus post`, `continue-on-error`). Both derive the post from the same
  `buildVerdictBusPost`.

## Consequences

- **The human verdict is coordination-visible.** The WIN plane + remote actors see the reviewer's
  PASS/FAIL as a typed, actionable bus event bound to the release task — the reviewer VM's judgment
  is no longer siloed on one machine.
- **Best-effort, never blocking.** The announcement never fails a signed release or the signing flow;
  it degrades to a logged skip when the bus/CLI/token is absent.
- **Reuses the bus, does not reinvent it.** It posts via the existing `lbabus` CLI (the authoritative
  GitHub-Discussion transport) that the extension already shells for notes/polls, with the same
  `bus-msg` collaboration semantics.
- **Completes the protocol.** With capture-status, correlator auto-jump, agent→human request, the
  signed reviewer verdict, and now the bus announcement, the Handoff Beacon Protocol's five governed
  tiers are all in place.
