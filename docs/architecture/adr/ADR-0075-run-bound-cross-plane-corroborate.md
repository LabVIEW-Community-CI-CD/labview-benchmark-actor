# ADR-0075: Run-bound cross-plane corroborate + compare — the ingested collection is corroborated across planes and the planes are compared (LBA-REQ-092)

- Status: Accepted
- Date: 2026-08-04
- Deciders: the agent-autonomy showcase campaign (operator: "think big, become ambitious, as many turns as you need" — a real N=2 cross-plane demo: one benchmark dispatched to two cross-plane actors, corroborated + compared, agent-driven) + agent
- Relates to: LBA-REQ-092 (realized here), LBA-REQ-091 / ADR-0074 (run-bound ingestion — its `receipt-collection@1` is this stage's input), LBA-REQ-076 / ADR-0057 (the fan-out collection contract), LBA-REQ-072 / ADR-0053 (the `launchIdentity` re-derived to re-prove the shared benchmark), LBA-REQ-010 (the benchmark-store `compareRuns` cross-plane compare core — REUSED here)

## Context

Increment 1 (LBA-REQ-091) binds a live dispatch + the actors' returned receipts into a run-bound `receipt-collection@1`.
The campaign milestone then requires the two planes' real-benchmark receipts to be **corroborated** (do a Linux actor and
a Windows actor genuinely agree the dispatched benchmark PASSED?) and **compared** (what is the cross-plane delta — the
candidate Windows launch timing against the baseline Linux one?). The benchmark-store already has a governed, pure
cross-plane compare core (`compareRuns`, LBA-REQ-010) and the mesh already binds a benchmark identity end-to-end, but
nothing consumed the run-bound collection to produce a single fail-closed cross-plane verdict + comparison for one
dispatched run. Without that stage, "corroborated + compared" is a hand-wave over the ingested receipts.

## Decision

- **Govern the run-bound corroborate + compare as LBA-REQ-092** with a pure, rg-free module
  (`experiments/mesh-fulfillment/meshCorroborate.mjs`) + a selftest (8/8) + the gate `mesh-cross-plane-corroborate`.
- **`corroborateRun({ collection })`** consumes the run-bound `receipt-collection@1` and CORROBORATES cross-plane,
  fail-closed: the collected plane-tagged receipts must span **≥ 2 distinct OS-planes** (crossPlane), each plane's
  `workload-trend@1` must **PASS**, each `receipt.plane` must match its collected plane, and each must **re-derive the
  dispatch identity** (`dispatchIdentity{metric,workload,n} === collection.identity`) so every plane provably ran the
  **same** dispatched benchmark. `corroborated` iff there are no findings.
- **The comparison REUSES benchmark-store `compareRuns`** (LBA-REQ-010, pure + deterministic — "works on two loose run
  records ... so the next agent can repeat the comparison anywhere"): the LINUX (baseline) + WIN (candidate) trends'
  launch metrics (`latest`, `mean`, `median`, `min`, `max`, `spread`, `baselineMs`) are paired into the governed
  `cross-plane-compare@v1` delta. No new comparison logic is written.
- **The run-bound report** `mesh-cross-plane-report@1` binds the corroboration + comparison to the `dispatchId` +
  `identity`.
- **The gate** `mesh-cross-plane-corroborate` proves, offline + deterministically, the selftest (8/8) + that the
  committed two-plane fan-out collection corroborates cross-plane with a comparison (exit 0 ⟺ crossPlane + all PASS +
  identity-bound).

## Consequences

- **The mesh loop now has its corroborate + compare stage** — dispatch → ingest (091) → **corroborate + compare (092)**
  — producing one run-bound cross-plane verdict + delta from the actors' real receipts, fail-closed unless both planes
  genuinely ran and passed the dispatched benchmark.
- **Zero new corroboration/compare gating primitives.** It reuses `compareRuns` (benchmark-store) + `dispatchIdentity`
  (mesh) verbatim; the module only binds them to the run-bound collection.
- **`[Assumption]`** cross-plane *corroboration* here is the run-scoped agreement (both planes PASS the same dispatched
  benchmark). Release-grade witness corroboration (version/sourceCommit/seriesHash agreement across enrolled witnesses,
  ADR-0068/`corroboratePlanes`) remains its own concern — this stage corroborates a benchmark *run*, not a release.
- Increment 3 (the live N=2 run) feeds real Linux + Windows launch-to-ready receipts through ingest (091) into this
  stage, and an agent driver (`lba mesh-run`) chains dispatch → ingest → corroborate as one operation.

## References

- Realizes: LBA-REQ-092 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-092`)
- Reuses: ADR-0074 (ingest), benchmark-store `compareRuns` (LBA-REQ-010), `dispatchIdentity` (ADR-0053)
- Standards baseline: repo-standards-review (the authoritative standards lens for this repo, ADR-0010)
