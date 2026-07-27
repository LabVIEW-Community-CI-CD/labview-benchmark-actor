# ADR-0004: UDP presence/liveness and advisory coordination time (no cross-VM comparison)

- Status: Proposed
- Owner: LINUX
- Traces to: LBA-REQ-007 (UDP presence/liveness for the coordination bus), LBA-REQ-006 (multi-VM); NOT a run-comparison mechanism (ADR-0006 / LBA-REQ-010 — runs are never compared across VMs)
- Standards baseline: `repo-standards-review` v0.2.19

## Context

Each run stamps metrics and frames on **one** monotonic run clock (ADR-0001),
and that clock is used **only VM-locally** — the viewer binds cursor→picture on
it (ADR-0002). Per ADR-0006 / LBA-REQ-010, **runs are never compared across
VMs**: each actor reviews its own prior runs, and completed runs are
concentrated to the operator host out-of-band for a host-side ollama layer. So
UDP here is **not** a cross-VM run-alignment mechanism. It serves the
coordination bus: **presence/liveness** (peer-drop detection) and an **optional,
advisory** common time reference for human-readable coordination-message
timestamps. LBA-REQ-007.3 requires that a lost UDP datagram **never** corrupt
the TCP-ordered coordination state.

## Decision

**1. Presence/liveness beacon (primary).** Each participant emits a UDP
heartbeat on the private network (default 1 Hz). A peer that misses `K`
consecutive beacons (default 3) is flagged **not-present** and cross-checked
against its TCP connection (ADR-0003 peer-drop, LBA-REQ-007.3). This is the
bus's liveness signal.

**2. Optional advisory coordination time.** The session leader (the ADR-0003 log
anchor) MAY include its clock in the beacon so participants can stamp
coordination messages with a loosely-common time for human-readable ordering. An
optional NTP-lite round trip (`PROBE T1` → leader `T2`/`T3` → `T4`,
`offset = ((T2 − T1) + (T3 − T4)) / 2`) refines that estimate. This time is
**advisory and best-effort** — coordination *ordering* is authoritative via the
leader's append-log sequence (ADR-0003), not wallclock — so there is **no
accuracy bound to meet**.

**3. No cross-VM run-clock alignment.** There is deliberately **no** skew bound
and **no** cross-VM timeline projection: runs are compared only VM-locally (own
runs) and by the host-side ollama layer over the concentrated corpus (ADR-0006),
never across VMs on the wire. Each VM's run clock stays private to that VM
(ADR-0001/0002).

**4. Loss-safe (LBA-REQ-007.3).** UDP loss only delays presence detection or
widens the advisory-time estimate; it can never reorder or corrupt the
TCP-ordered coordination state, and it cannot affect a single VM's own
metric↔picture binding (that is intra-VM on the ADR-0001 clock).

## Consequences

- **+** UDP does one clear job — bus **presence/liveness** — with time demoted
  to an advisory convenience; no accuracy target to meet or measure.
- **+** Time/presence loss is isolated from coordination correctness
  (LBA-REQ-007.3): ordering is authoritative on the TCP append-log, not UDP.
- **+** Cleanroom-consistent: no cross-VM run data or run-clock alignment on the
  wire (ADR-0005 / ADR-0006).
- **−** A 1 Hz heartbeat adds steady low-rate UDP traffic; negligible on a
  private network and tunable.
- **−** Advisory-time inherits the ADR-0003 leader-failover open question (a new
  leader re-establishes the reference).
- **Open:** heartbeat cadence / miss-count `K` to confirm on the real Vagrant
  network (T-007); 1 Hz / K=3 is the starting point.
