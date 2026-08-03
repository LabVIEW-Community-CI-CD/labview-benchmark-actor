# ADR-0063: The benchmark-suite parity observatory — one coverage view over the cross-plane parity families (LBA-REQ-082)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 2 → Phase 4 (the benchmark suite → cross-plane comparison at scale) + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-082 (realized here), LBA-REQ-072 / ADR-0053 (launch parity — folded), LBA-REQ-081 / ADR-0062 (VI Analyzer parity — folded), LBA-REQ-075 / ADR-0056 (the mesh coverage observatory — the pattern this mirrors for the benchmark suite)

## Context

The benchmark suite now has two cross-plane parity families — launch (LBA-REQ-072) and VI Analyzer (LBA-REQ-081) —
each a separate fail-closed gate over its own parity receipt with its own schema. But there is no single view that
answers the operator's Phase-2 question: *which benchmark families have proven cross-plane parity, and what is
their Linux-vs-Windows timing?* The mesh already has its analogue — the mesh coverage observatory (LBA-REQ-075)
folds the committed mesh receipts into one coverage matrix — so the benchmark suite should have the same:
a folded, governed, fail-closed suite view that composes the parity receipts and grows as new families land.

## Decision

- **Govern the benchmark-suite parity observatory as LBA-REQ-082** with a pure, rg-free verifier
  (`experiments/benchmark-suite/suiteParityObservatory.mjs`) + a committed observatory
  (`benchmark-suite-parity-observatory-receipt.json`) + a selftest (7/7) + the gate
  `benchmark-suite-parity-observatory`.
- **`foldParity` normalizes each family's receipt** — the two families have different schemas
  (`cross-plane-launch-parity-receipt@1`, `cross-plane-vi-analyzer-parity-receipt@1`) — into a uniform coverage row:
  the family name (derived from the schema), the benchmark spec, the identity (`launchIdentity` or
  `benchmarkIdentity`), the shared parity flags (`crossPlane`, `identityMatch`, and `resultHashMatch` where the
  family has a deterministic result), the `parityProven` verdict, and the LINUX-vs-WIN performance witness.
- **The coverage matrix + verdict** are DERIVED from the rows: the family count, the parity-proven count, the family
  list, and `observatoryOk` iff every folded family is parity-proven. `validateObservatory` fails closed on a row
  that claims parity without cross-plane + identity match, a miscounted coverage statistic, a verdict that
  contradicts the folded rows, or a tampered digest; the gate additionally re-folds the committed parity receipts
  (currency) and checks each row is grounded in a real receipt's identity.
- **The gate** `benchmark-suite-parity-observatory` proves, offline + deterministically: the selftest (7/7); the
  committed observatory validates + the whole suite is parity-proven; it re-folds byte-stably from the committed
  launch + VI Analyzer parity receipts; and each folded row carries the real receipt identity.

## Consequences

- **The benchmark suite has an operator-facing parity dashboard** — a single governed artifact answering "which
  benchmark families are cross-plane parity-proven, and their Linux-vs-Windows timing." This is the roadmap Phase-2
  capstone and the bridge to Phase 4 (cross-plane comparison at scale).
- **It grows with the suite, with no new machinery** — folding a mass-compile or unit-test parity receipt (once real
  two-plane timing exists) extends the matrix and the counts automatically; the fold is schema-driven and the
  family name comes from the receipt schema.
- **The suite and the mesh now have symmetric observatories** — the mesh coverage observatory (LBA-REQ-075) over the
  mesh receipts and this one over the benchmark parity receipts, both folded fail-closed from committed data with no
  central database.
- The gate is DETERMINISTIC + offline (no VM / network at gate time; it folds committed receipts), consistent with
  the rg-free / tool-free CI constraint, and re-derives the observatory byte-stably so "the dashboard reflects the
  parity receipts" is itself gated. Authored under the singular-requirement directive (one `shall`).
