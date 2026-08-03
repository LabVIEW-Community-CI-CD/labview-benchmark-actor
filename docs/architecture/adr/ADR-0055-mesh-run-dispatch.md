# ADR-0055: GitHub-native mesh-run dispatch transport — repository_dispatch closes the dispatch→fulfill loop (LBA-REQ-074)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "GitHub-native distributed runs via repository_dispatch / Actions, zero central infra") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-074 (realized here), LBA-REQ-073 / ADR-0054 (mesh-run fulfillment — the DISPATCH's counterpart, whose verifier this workflow GATES), LBA-REQ-072 (the `launchIdentity` bound into the dispatch), LBA-REQ-018 (provider-delegation dispatch primitives), the release-enforcement pattern of LBA-REQ-071 / ADR-0052 (a workflow wired to a fail-closed gate)

## Context

LBA-REQ-073 governs the FULFILLMENT half of the North Star loop (a dispatched run proven fulfilled by >= N
cross-plane actors). The DISPATCH half — the GitHub-native transport that actually fans a run request out to
volunteer actors and collects their returned receipts — did not exist: no `.github/workflows/` uses
`repository_dispatch`, and there was no committed dispatch-request contract binding a dispatch to its fulfillment.
The roadmap is explicit that on-demand runs are dispatched through the repo (`repository_dispatch` / Actions as
the queue) — no server to run, fully auditable, a natural fit for "coordinate runs, don't hoard data."

## Decision

- **Govern the mesh-run dispatch transport as LBA-REQ-074** with a committed `mesh-run-dispatch@1` request
  (`experiments/mesh-fulfillment/mesh-run-dispatch-request.json`) + a pure, rg-free verifier (`meshDispatch.mjs`)
  + a selftest (7/7) + a `repository_dispatch` workflow (`.github/workflows/mesh-run.yml`) + the gate
  `mesh-run-dispatch-wired`.
- **The dispatch request** names the benchmark (`benchmarkId` + a `{ metric, workload, n }` spec), how many
  independent actors are required (`minActors`), which planes must be covered (`requestedPlanes`), and a
  `dispatchId`. It carries the **same** `launchIdentity` (LBA-REQ-072) as the fulfillment, so a dispatch and its
  fulfillment are provably the SAME run. The verifier fails closed on a missing benchmarkId, an out-of-range
  minActors, an empty/invalid requested-planes set, an identity mismatch, or a tampered digest.
- **The workflow** (`mesh-run.yml`) triggers on `repository_dispatch` (event type `mesh-run`) — the
  client_payload IS the `mesh-run-dispatch@1` request; the repo is the queue. It validates the dispatch
  (`meshDispatch.mjs`, fail-closed) and then gates the returned receipts on cross-plane fulfillment
  (`meshFulfillment.mjs`, LBA-REQ-073). This mirrors the release-enforcement wiring of ADR-0052.
- **The gate** `mesh-run-dispatch-wired` proves, offline + deterministically: the dispatch request validates +
  fails closed on a malformed request; the committed request BINDS to the LBA-REQ-073 fulfillment (same
  benchmarkId + identity + minActors + planes); and `mesh-run.yml` is wired (triggers on
  `repository_dispatch[mesh-run]` and runs both the dispatch validator + the fulfillment gate).

## Consequences

- **The dispatch→fulfill loop is closed GitHub-natively** — a requester dispatches a `mesh-run` event, the repo
  fans it out, volunteer actors return plane-tagged receipts, and the fulfillment gate proves the run was
  fulfilled by enough independent cross-plane actors. Zero central infra, fully auditable, no central results DB.
- **A dispatch and its fulfillment are provably the same run** (the shared `launchIdentity`), so a returned
  receipt set cannot be silently substituted for a different benchmark.
- **The live fan-out is the next Phase-3 increment (flagged):** the workflow triggers + gates today; wiring it to
  actually create actor tasking (issues / `repository_dispatch` to actor repos, or actor polling) and collect
  their receipts as Actions artifacts is the natural follow-on. This ADR governs the dispatch CONTRACT + the
  wired trigger; the receipts the gate consumes are the committed proof.
- The gate is DETERMINISTIC + offline (no network / actors at gate time), consistent with the rg-free / tool-free
  CI constraint. Authored under the singular-requirement directive (one `shall`).
