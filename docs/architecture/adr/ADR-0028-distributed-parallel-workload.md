# ADR-0028: Distribute the workload across an N-instance ripgrep-only pool, capacity-weighted and budget-capped

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08) + agent (interviewed the operator to assume nothing)
- Relates to: LBA-REQ-040, ADR-0023 (personal golden-VM onboarding / mesh actors), docs/roadmap.md (North Star distributed mesh)

## Context

The roadmap's North Star is on-demand **distributed** benchmark runs across planes
(OS × hardware × LabVIEW version) with no central aggregation. The operator asked
to spread the agent's own workload across more than one instance — "as many as the
budget can afford" — using codespaces and/or local VMs, with every instance
searching via **ripgrep only**. A first primitive was prototyped for two
instances; the operator directed it must **not** be two-specific: N heterogeneous
instances (host + codespaces + VMs), dynamically discovered, capacity-weighted,
budget-capped.

## Decision

- **Dynamic discovery (no committed registry):** enumerate the pool at run time —
  the host (always; the fastest worker) + labview-benchmark-actor codespaces
  (`gh codespace list`) + running local VMs (`vagrant global-status`).
- **Budget cap:** a conservative default of **host + 2 remote** instances,
  concurrency = pool size, overridable per run; may auto-resume stopped instances
  up to the cap.
- **Capacity-weighted split:** static per-type weights (host fastest, VM medium,
  codespace slowest) drive a deterministic proportional partition, so faster
  instances get more tasks.
- **Direct SSH adapters per type:** local spawn / `gh codespace ssh` /
  `vagrant ssh`.
- **Ripgrep-only:** every instance discovers and searches with ripgrep; each shard
  attests it.
- **Fail-closed gate:** a committed real receipt must validate — the capacity
  split re-derived from the recorded weights reproduces the disjoint shards, the
  instances are distinct, all searched with ripgrep, and every task passed.

This is requirement **LBA-REQ-040**. The first workload is the repo's experiment
self-tests; the executor is task-agnostic, aimed at cross-plane benchmark runs.

## Consequences

- The agent (and future agents) can spread verification/benchmark load across the
  host + codespaces + VMs concurrently, freeing the host — the only instance with
  LabVIEW — for LabVIEW-specific work.
- The primitive is **N-generic** and budget-aware: a concrete step toward the
  North Star distributed benchmark mesh, not a two-instance special case.
- Proven **live across three instances** (this host + two codespaces): 42
  self-tests split 25 / 9 / 8, all passed concurrently, receipt gated.
- Future refinements (also flagged in `scripts/lba.mjs`): measured/adaptive
  weights instead of static, exercised VM adapters, and work-stealing for tighter
  balance across very heterogeneous fleets.
