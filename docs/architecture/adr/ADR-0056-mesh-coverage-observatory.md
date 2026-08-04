# ADR-0056: The mesh coverage observatory — folding the governed mesh-run receipts into a coverage matrix + consistency ledger (LBA-REQ-075)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3→4 (the actor mesh at scale — "cross-plane comparison, an operator-facing dashboard") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-075 (realized here), LBA-REQ-074 / ADR-0055 (mesh-run dispatch — folded), LBA-REQ-073 / ADR-0054 (mesh-run fulfillment — folded), LBA-REQ-072 / ADR-0053 (cross-plane launch parity — folded), LBA-REQ-054 (the benchmark observatory — the single-plane precedent this mirrors for the MESH)

## Context

The mesh dispatch→fulfill loop is now closed end-to-end (dispatch LBA-REQ-074 → fulfillment LBA-REQ-073, with
cross-plane parity LBA-REQ-072). But those receipts live as three separate artifacts; there is no single,
governed view answering the operator's question — *which benchmarks have been fulfilled, across which planes, by
how many actors, and does each run hang together?* The benchmark observatory (LBA-REQ-054) already established the
pattern for a single plane (fold committed benchmark receipts into a status surface); the mesh needs its
counterpart. Without it, "cross-plane comparison at scale" (roadmap Phase 3→4) has no coherent, fail-closed
dashboard, and nothing cross-checks that a run's dispatch, its fulfillment, and its parity all name the SAME
benchmark identity.

## Decision

- **Govern the mesh coverage observatory as LBA-REQ-075** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshObservatory.mjs`) + a committed observatory
  (`mesh-coverage-observatory-receipt.json`) + a selftest (7/7) + the gate `mesh-coverage-observatory`.
- **The observatory folds each mesh run** — its dispatch (`mesh-run-dispatch@1`, LBA-REQ-074), its fulfillment
  (`mesh-run-fulfillment-receipt@1`, LBA-REQ-073), and its cross-plane parity
  (`cross-plane-launch-parity-receipt@1`, LBA-REQ-072) — into a coverage **row**: the benchmark id + identity,
  whether it was dispatched + fulfilled, how many distinct actors responded, which planes they covered, whether
  parity is proven, and a **`consistent`** flag that is true iff a dispatch AND a fulfilled fulfillment are
  present and every folded artifact names the SAME benchmark identity (the same run).
- **The coverage matrix + consistency ledger** are DERIVED from the rows: counts of benchmarks / fulfilled /
  parity-proven / consistent runs, the union of covered planes, the total actor-runs, and a ledger asserting all
  runs are dispatched, fulfilled, and identity-consistent. The verifier fails closed on a run whose
  dispatch/fulfillment/parity disagree on identity, an un-fulfilled run counted as coherent, a miscounted
  coverage statistic, a stale re-fold (the committed observatory must reproduce byte-for-byte from the committed
  source receipts), or a tampered digest.
- **The gate** `mesh-coverage-observatory` proves, offline + deterministically: the selftest (7/7); the committed
  observatory validates + is coherent; coverage spans the fulfilled benchmarks across the LINUX + WIN planes; and
  the folded row is **grounded** in the real LBA-REQ-073 fulfillment (same identity + actor count + covered
  planes), so the dashboard cannot drift from the receipts it summarizes.

## Consequences

- **The mesh has an operator-facing dashboard** — a single governed artifact answering "which benchmarks × which
  planes × how many actors fulfilled, and is each run coherent." This is the Phase 3→4 bridge: cross-plane
  comparison AT SCALE, folded from the committed receipts with no central results database.
- **Dispatch, fulfillment, and parity are cross-checked for coherence** — the observatory refuses to present a run
  as fulfilled unless its dispatch and its returned receipts (and its parity) name the same benchmark identity, so
  a substituted or mismatched receipt set is caught at the dashboard, not just at each individual gate.
- **The observatory grows with the mesh** — folding additional fulfilled runs (more benchmarks, more planes, more
  actors) extends the matrix without new machinery; the coverage counts and the ledger re-derive. Today it folds
  the one committed launch run (2 actors across LINUX + WIN); the verifier is written to fold N runs.
- The gate is DETERMINISTIC + offline (no VM / network / actors at gate time), consistent with the rg-free /
  tool-free CI constraint, and re-derives the observatory byte-stably so "the dashboard reflects the receipts" is
  itself gated. Authored under the singular-requirement directive (one `shall`).
