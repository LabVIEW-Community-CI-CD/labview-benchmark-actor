# ADR-0004: Cross-VM time-sync — UDP beacon cadence and skew bound

- Status: Proposed
- Owner: LINUX
- Traces to: LBA-REQ-006 (multi-VM topology), LBA-REQ-007 (UDP presence/time-sync); supports cross-VM comparison of the ADR-0001 run clock
- Standards baseline: `repo-standards-review` v0.2.19

## Context

Each run stamps metrics and frames on **one** monotonic run clock (ADR-0001).
For a single VM that is sufficient — the viewer binds cursor→picture on that one
clock (ADR-0002). LBA-REQ-006 runs benchmarks on **multiple** VMs in one
session, and comparing them (aligning VM-A's metric/picture timeline against
VM-B's) requires their run clocks to relate within a **bounded skew**.
LBA-REQ-007 places presence/liveness and time-sync on **UDP** (low latency,
loss-tolerant) and requires that a lost UDP beacon **never** corrupt the
TCP-ordered coordination state (LBA-REQ-007.3).

## Decision

**1. Leader as clock reference.** The session leader (the TCP log anchor of
ADR-0003) is the session time reference. Peer offsets are expressed relative to
the leader clock, so cross-VM alignment lives in one common frame — the simplest
model and consistent with one-owner-per-hotspot (AD-7).

**2. UDP beacon at 1 Hz plus an NTP-lite round trip.** The leader broadcasts a
beacon each second on the private network carrying its monotonic clock and
wallclock. For an accurate per-peer **offset** (not merely one-way latency), a
peer runs a lightweight round trip: it sends a `PROBE` stamped `T1`; the leader
replies with its receive/transmit stamps `T2`/`T3`; the peer records reply time
`T4` and computes NTP-style `offset = ((T2 − T1) + (T3 − T4)) / 2` and
`rtt = (T4 − T1) − (T3 − T2)`, discarding samples whose `rtt` exceeds a
threshold and smoothing over a small window. Presence/liveness rides the same
beacon: a peer that misses `K` consecutive beacons (default 3) is flagged
not-present and cross-checked against its TCP connection (ADR-0003 peer-drop).

**3. Skew is ADVISORY, never authoritative.** Each VM's own run clock stays
monotonic and independent; the leader offset is applied only **post-hoc**, at
comparison time, to project one VM's timeline onto another. A lost or late UDP
beacon therefore only widens the offset confidence interval momentarily — it can
never reorder or corrupt TCP coordination state (LBA-REQ-007.3), and it cannot
desynchronize a single VM's own metric↔picture binding (that binding is
intra-VM, on the one run clock of ADR-0001/0002).

**4. Concrete skew bound and degraded flag.** Target: on a private Vagrant
network, cross-VM timestamps align within **±5 ms**, measured as the maximum
pairwise offset residual after sync. If the estimated skew for a pair exceeds the
bound (beacon loss, congestion, VM suspend), a cross-VM comparison is labeled
**skew-degraded** with the estimated bound shown, rather than silently aligning a
metric against a picture from another VM. Single-VM viewing (the common
LBA-REQ-004/005 case) is unaffected — it uses only that VM's clock.

## Consequences

- **+** Cross-VM comparison has a defined, measurable alignment bound and a safe
  degraded state rather than a silent mis-alignment.
- **+** Time-sync loss is isolated from coordination correctness (LBA-REQ-007.3)
  — UDP is best-effort by construction.
- **+** Presence and time-sync share one beacon (fewer moving parts).
- **−** A 1 Hz beacon plus round-trip probes add steady low-rate UDP traffic;
  negligible on a private network, and the cadence is tunable if the bound needs
  tightening.
- **−** Leader-referenced time inherits the leader-failover open question from
  ADR-0003 (a new leader re-establishes the reference; peers re-probe).
- **Open:** the exact beacon cadence vs skew-bound tradeoff, to be confirmed
  empirically on the real Vagrant network (T-006/T-007); 1 Hz / ±5 ms is the
  starting target.
- **Open:** whether a VM suspend/resume needs an explicit re-sync signal on
  resume (likely yes, since the monotonic clock pauses) — a refinement.
