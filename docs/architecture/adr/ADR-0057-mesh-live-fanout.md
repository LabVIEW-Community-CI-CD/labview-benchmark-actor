# ADR-0057: The live fan-out contract — actor-tasking + receipt-collection bind a dispatch to its fulfillment (LBA-REQ-076)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "dispatch runs to volunteer actors + collect their receipts, zero central infra") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-076 (realized here), LBA-REQ-074 / ADR-0055 (mesh-run dispatch — the fan-out's input), LBA-REQ-073 / ADR-0054 (mesh-run fulfillment — the fan-out's output), LBA-REQ-072 / ADR-0053 (the `launchIdentity` bound end-to-end), LBA-REQ-075 / ADR-0056 (the observatory over the fulfilled runs)

## Context

The mesh dispatch→fulfill loop is governed at its two ends — a dispatch request (LBA-REQ-074) is validated, and a
returned receipt set is gated for fulfillment (LBA-REQ-073) — but the MIDDLE was not: nothing governed how a
validated dispatch is expanded into per-actor *tasking*, nor how the actors' returned plane-tagged receipts are
*collected* back into the fulfillment input. Without that contract, the "fan-out" is a hand-wave: a returned
receipt set could be assembled from receipts that never corresponded to the dispatched tasks, or that ran a
different benchmark, and the fulfillment gate would still pass on the assembled set. The roadmap's live fan-out
(task volunteer actors through the repo, collect their receipts as run artifacts) needs a fail-closed,
identity-bound contract for the tasking and the collection so the collected set provably descends from the
dispatch.

## Decision

- **Govern the live fan-out contract as LBA-REQ-076** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshFanout.mjs`) + a committed tasking (`mesh-run-tasking.json`) + a committed
  collection (`mesh-run-collection.json`) + a selftest (7/7) + a fan-out step wired into
  `.github/workflows/mesh-run.yml` + the gate `mesh-live-fanout-wired`.
- **The tasking** (`actor-tasking@1`) is DERIVED from a validated dispatch: one task per requested plane, each
  carrying the `dispatchId`, the `benchmarkId` + `{ metric, workload, n }` spec, the plane, and the dispatched
  `launchIdentity` (LBA-REQ-072). `validateTasking` fails closed on a task unbound from the dispatch id/identity,
  an invalid or duplicate plane, a non-canonical `taskId`, a benchmark spec that does not hash to the tasking
  identity, tasks that do not cover the requested planes, or a tampered digest.
- **The collection** (`receipt-collection@1`) maps each returned plane-tagged receipt back to its task and
  produces the `{ actorId, plane, receipt }` actor set that `meshFulfillment` (LBA-REQ-073) consumes.
  `validateCollection` fails closed on a collected receipt whose `taskId` has no matching task, a plane mismatch,
  an invalid trend, a receipt whose identity ≠ the dispatched identity, a duplicate actor, an uncovered tasked
  plane, or a tampered digest.
- **The gate** `mesh-live-fanout-wired` proves, offline + deterministically: the selftest (7/7); the committed
  tasking + collection validate (via the CLI); the tasking is CURRENT (it re-derives byte-for-byte from the
  committed dispatch); the fan-out is IDENTITY-BOUND end-to-end (tasking + collection + fulfillment share the one
  benchmark identity); the collection RECONSTRUCTS the committed LBA-REQ-073 fulfillment (its actor set is the
  fulfillment's actor set — grounding); and `mesh-run.yml` runs the fan-out step.

## Consequences

- **The fan-out is now governed end-to-end** — dispatch → tasking → [actors run] → collection → fulfillment →
  observatory — with the benchmark identity bound at every hop, so a collected receipt provably descends from the
  dispatched tasks and ran the dispatched benchmark. A substituted or mismatched receipt is caught at the
  collection, not just at the aggregate fulfillment check.
- **The live execution can be wired without new governance** — `mesh-run.yml` now derives the tasking and
  validates the collection between validating the dispatch and gating the fulfillment; making the actors actually
  run their task and upload their receipt as a run artifact (or return it in a follow-up `repository_dispatch`)
  slots into the collection contract. This ADR governs the CONTRACT; the committed tasking + collection are the
  proof, and the live execution stays out of CI.
- **The committed receipts descend from one real run** — the committed collection is exactly the two golden-VM
  actor receipts of the committed fulfillment (golden-linux LINUX + golden-win WIN), so the fan-out artifacts and
  the fulfillment are provably the same run.
- The gate is DETERMINISTIC + offline (no VM / network / actors at gate time), consistent with the rg-free /
  tool-free CI constraint, and re-derives the tasking + digests byte-stably. Authored under the
  singular-requirement directive (one `shall`).
