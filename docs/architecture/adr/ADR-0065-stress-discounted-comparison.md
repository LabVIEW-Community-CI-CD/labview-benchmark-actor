# ADR-0065: The stress-discounted cross-plane comparison — the calibration discounts a result captured on a stressed actor (LBA-REQ-084)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 4 (cross-plane comparison at scale — "the mesh-stress-signature calibration lets a run discount a result captured on a stressed actor") + operator ("complete stage 4 before stage 5") + agent
- Relates to: LBA-REQ-084 (realized here), LBA-REQ-032 (the mesh-stress-signature calibration reused — the ladder + concurrent-actors captures + inverse-read), LBA-REQ-072 / LBA-REQ-081 (the cross-plane parity comparisons this quality-weights), LBA-REQ-050 / LBA-REQ-054 (the benchmark grid + observatory)

## Context

Cross-plane comparison is built out (launch parity LBA-REQ-072, VI Analyzer parity LBA-REQ-081, the benchmark grid
LBA-REQ-050, the observatory LBA-REQ-054), but every comparison so far treats each actor's result at face value. The
roadmap's Phase-4 language is explicit that this is not enough at scale: *"the mesh-stress-signature calibration
lets a run discount a result captured on a stressed actor."* A benchmark captured on an actor under heavy CPU
contention is not a fair sample — its timing is inflated by the contention — so a fair cross-plane comparison must
weight it down. The project already has the calibration to do this (LBA-REQ-032): the mesh-stress ladder proves a
monotone, separable, repeatable stress model, and the concurrent-actors capture proves the calibration can
INDEPENDENTLY recover each actor's stress level from its resource signature. What was missing is the governed step
that turns that calibration into a per-measurement discount.

## Decision

- **Govern the stress-discounted comparison as LBA-REQ-084** with a pure, rg-free verifier
  (`experiments/mesh-stress-signature/stressDiscountedComparison.mjs`) + a committed comparison
  (`stress-discounted-comparison-receipt.json`) + a selftest (7/7) + the gate `stress-discounted-comparison`.
- **The calibration authority is the committed ladder** (`mesh-stress-live-ladder@1`): a comparison trusts the
  calibration only when the ladder's invariants hold (monotone + separable + repeatable). **The measurements are
  the committed concurrent-actors capture** (`mesh-concurrent-actors@1`), whose `perActorInverseRead` +
  `allActorsRecovered` prove each actor's stress was independently recovered from its resource signature.
- **Each measurement is assigned a stress-QUALITY weight** — a linear confidence from the recovered stress level
  (idle → 1.0, light → 0.75, medium → 0.5, heavy → 0.25, saturate → 0.0) — and flagged **discounted** at or above
  `heavy`. This is a confidence weight, NOT a fabricated millisecond correction: it expresses how much a comparison
  should trust each actor's result, so a consumer keeps the clean (low-stress) measurements at full weight and
  down-weights the contended ones.
- **Discounting is applied** iff the calibration is trustworthy, every actor was recovered, at least one stressed
  measurement is discounted, and at least one clean measurement is kept at full confidence. `validateComparison`
  re-derives the comparison byte-stably from the two committed mesh-stress receipts (currency + grounding) and
  fails closed on an invalid calibration, an unrecovered actor, a weight/flag that does not match the rule, a
  miscounted coverage statistic, or a tampered digest.
- **The gate** `stress-discounted-comparison` proves, offline + deterministically: the selftest (7/7); the
  committed comparison re-derives from the ladder + concurrent captures via the CLI; the idle actor is kept at full
  confidence and the saturate actor is discounted to zero weight; and a clean/discounted split exists.

## Consequences

- **Cross-plane comparison is now stress-aware** — a fair comparison discounts a result captured on a stressed
  actor (the two most-contended actors here, heavy + saturate, are discounted; the idle/light/medium actors are
  kept), realizing the roadmap's Phase-4 requirement on the real committed calibration. The clean measurements at
  full weight are the trustworthy comparison set; the discounted ones are flagged, not silently mixed in.
- **It composes the existing calibration** (LBA-REQ-032) rather than inventing a new stress model — the ladder is
  the authority and the concurrent capture is the recovery, both real and committed, so there is no fabricated
  degradation factor. The weight is an honest confidence, and the ADR is explicit that it is not a timing
  correction.
- **It extends to real benchmark comparisons** — any cross-plane benchmark comparison whose actors carry a
  capture-time resource signature can be run through this discounter to obtain a stress-quality-weighted verdict; a
  future increment can fold the discount weight into the benchmark grid / observatory so the comparison-at-scale
  views carry stress provenance.
- The gate is DETERMINISTIC + offline (no VM / stress at gate time; it folds committed captures), consistent with
  the rg-free / tool-free CI constraint, and re-derives byte-stably so "the discount reflects the calibration" is
  itself gated. Authored under the singular-requirement directive (one `shall`).
