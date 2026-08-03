# ADR-0061: The composite mesh-run-attested decision — one verdict a consumer checks to trust a mesh run end-to-end (LBA-REQ-080)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "one decision to trust a run") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-080 (realized here), LBA-REQ-072..079 (the composed mesh sub-proofs), LBA-REQ-071 / ADR-0052 (the composite-release-decision pattern this mirrors — conjoin independent gates into one enforced decision)

## Context

The mesh subsystem is now built out across eight requirements — cross-plane parity (LBA-REQ-072), fulfillment
(LBA-REQ-073), dispatch (LBA-REQ-074), the coverage observatory (LBA-REQ-075), the fan-out contract (LBA-REQ-076),
the verified tier (LBA-REQ-077), the transparency log (LBA-REQ-078), and the append-only proof (LBA-REQ-079). Each
is a fail-closed gate over its own receipt. But a consumer that wants to TRUST a mesh run (e.g. before letting its
result inform a release) has no single decision to check: it would have to run five separate verifiers and, worse,
confirm by hand that they all refer to the SAME run rather than a mix of receipts from different runs. The project
already has the pattern for this — the composite-release-decision (LBA-REQ-071) conjoins the machine-quorum gate
and the human-visual gate into one enforced verdict bound to the same candidate. The mesh needs its analogue.

## Decision

- **Govern the composite decision as LBA-REQ-080** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshAttested.mjs`) + a committed decision (`mesh-run-attested-receipt.json`) + a
  selftest (7/7) + a capstone step in `.github/workflows/mesh-run.yml` + the gate `mesh-run-attested`.
- **`decideAttested` conjoins the five sub-proofs** by REUSING their verifiers — `decideFulfillment` (073),
  `validateReceipt` on the parity receipt (072), `validateVerifiedCollection` (077), `validateLoggedCollection`
  (078), and `validateHistory` (079) — with no new proof logic. A run is `attested` iff every gate passes AND all
  five layers name the SAME run identity (`fulfillment.identity === parity.launchIdentity === verified.identity ===
  logged.identity === decideFulfillment(...).identity`) — the cross-proof identity binding that stops a verdict
  being assembled from receipts of different runs.
- **A `mesh-run-attested@1`** receipt records the five gate booleans, the shared identity, the identity-consistency
  flag, and the `attested` verdict. `validateReceipt` re-derives the decision from the committed source receipts
  (currency) and fails closed on a stale gate set, an identity mismatch, a verdict that contradicts the re-derived
  decision, or a tampered digest.
- **The gate** `mesh-run-attested` proves, offline + deterministically: the selftest (7/7); the committed decision
  re-derives from every committed source receipt via the CLI; all five composed sub-proofs pass; the identity is
  consistent; and `mesh-run.yml` runs the capstone step (last, after the individual gates).

## Consequences

- **A mesh run is trustable through ONE decision** — a consumer checks `mesh-run-attested@1` and learns, fail-closed,
  that the run was fulfilled by enough cross-plane actors, that its two planes measured the same benchmark, that
  every returned receipt is enrolled-signed, transparency-included, and in an append-only log, and that all of this
  refers to the same run. This is the integration capstone of the mesh subsystem.
- **The cross-proof identity binding is explicit** — the composite refuses to attest a run whose sub-proofs do not
  all name the same benchmark identity, closing the gap where five individually-valid receipts from different runs
  could be presented together.
- **It reuses every sub-verifier** — the composite adds only their conjunction and the identity binding, so a change
  to any sub-proof flows through automatically and there is no duplicated logic to drift. It mirrors the
  composite-release-decision (LBA-REQ-071), so the mesh's "one decision" has the same shape as the release's.
- **The mesh subsystem is complete** — 072–080 form a distributed benchmark mesh with the full
  identity + structural + enrolled-signature + transparency-inclusion + append-only trust chain, consumable as one
  attested verdict, all governed fail-closed and offline. Further work is breadth (new benchmark families, new
  roadmap threads), not depth here.
- The gate is DETERMINISTIC + offline (no VM / network / keys at gate time; it re-derives the decision from committed
  receipts), consistent with the rg-free / tool-free CI constraint. Authored under the singular-requirement
  directive (one `shall`).
