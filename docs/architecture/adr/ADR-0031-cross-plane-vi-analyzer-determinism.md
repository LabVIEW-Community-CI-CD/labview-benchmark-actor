# ADR-0031: Cross-plane VI Analyzer determinism — the same config yields the same resultHash across planes

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "cross-plane VI Analyzer resultHash comparison") + agent
- Relates to: LBA-REQ-043, ADR-0030 (cross-plane liveness), ADR-0029 (capability routing), LBA-REQ-015 (VI Analyzer cross-plane benchmark), docs/roadmap.md (North Star)

## Context

Cross-plane *liveness* (ADR-0030) proved the fleet has ≥ 2 activated LabVIEW
planes. The North Star is cross-plane *comparison*: an objective, reproducible way
to say two planes computed the same benchmark result. LBA-REQ-015 already defined
a **deterministic resultHash** over a VI Analyzer run (canonicalized counts +
findings, independent of report ordering), designed so two planes summarizing the
same run produce the SAME hash.

## Decision

- **Run the same VI Analyzer config on every LabVIEW plane** (the shipped
  `LabVIEWCLIExampleProject`, 3 VIs → 69 tests) concurrently — host locally, VMs
  over ssh.
- **Compute each plane's resultHash** via the established
  `summarizeViAnalyzerReport` (LBA-REQ-015). The Linux example-project ASCII report
  is parsed by a small format-specific reader (the LBA-REQ-015 parser targets the
  Windows icon-editor report; it is left untouched).
- **Assert the resultHashes MATCH across planes** and record the consensus.
- **Gate it fail-closed** (`cross-plane-vi-analyzer-determinism`): the committed
  receipt must show ≥ 2 distinct planes, each with a resultHash, all identical.

This is requirement **LBA-REQ-043**.

## Consequences

- **The North Star is demonstrated**: the same benchmark on two independent,
  activated LabVIEW planes (this host + the Ubuntu golden VM) produced a
  **byte-identical resultHash** — objective, reproducible cross-plane equivalence,
  not a subjective claim.
- Liveness (ADR-0030) is turned into comparison: the fleet can now say two planes
  *agree* on a benchmark, and a divergence fails the gate.
- The mechanism generalizes: a Windows LabVIEW plane (OS cross-axis) or a heavier
  benchmark VI slots into the same resultHash comparison.
