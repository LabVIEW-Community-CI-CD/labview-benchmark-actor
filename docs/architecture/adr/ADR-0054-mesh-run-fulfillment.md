# ADR-0054: Mesh-run cross-plane fulfillment — the North Star loop, governed (LBA-REQ-073)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — the §8 success metric "a requester dispatches a run and receives >= 2 independent, plane-tagged receipts from volunteer actors") + operator ("think bigger") + agent
- Relates to: LBA-REQ-073 (realized here), LBA-REQ-072 / ADR-0053 (cross-plane launch parity — its `launchIdentity` is REUSED as the benchmark identity), LBA-REQ-039 (mesh-actor registration — the enrolled actor identity source), LBA-REQ-018 (provider-delegation CLAIM/ACK/DONE dispatch primitives — the reusable transport), LBA-REQ-014 (mprr cross-plane parity), the golden-VM launch trends (`experiments/launch-parity/fixtures/{linux,win}-launch-trend.json`)

## Context

The North Star is a horizontally-scaled, sandbox-isolated benchmark **actor mesh**: a requester DISPATCHES a
cross-plane benchmark run, and independent volunteer golden-VM actors from different planes run it in their
sandboxes and RETURN plane-tagged receipts — coordinated GitHub-natively, with **no central results database**
(the receipts ARE the result). The analysis half is done: LBA-REQ-072 proves two planes ran the *same* launch
benchmark. The pieces for the coordination half exist but are not composed into a fulfillment proof: LBA-REQ-039
enrolls a golden VM as an actor (but does not prove a dispatched run was fulfilled); LBA-REQ-040/041 prove
distributed shard execution + capability routing among ripgrep-only instances (not benchmark receipts from
independent mesh actors); LBA-REQ-018 (provider-delegation) proves CLAIM/ACK/DONE dispatch over the bus for
uplift/doc/test domains (not benchmark-mesh fulfillment tied to one `benchmarkId` across planes). Nothing proved
the §8 metric: a dispatched cross-plane benchmark run FULFILLED by >= N independent cross-plane actors.

## Decision

- **Govern mesh-run cross-plane fulfillment as LBA-REQ-073** with a committed fail-closed receipt
  (`experiments/mesh-fulfillment/mesh-run-fulfillment-receipt.json`, schema `mesh-run-fulfillment-receipt@1`) + a
  pure, rg-free verifier (`meshFulfillment.mjs`) + a selftest (7/7) + the gate `mesh-run-cross-plane-fulfillment`.
- A run is **fulfilled** iff: >= `minActors` **distinct** enrolled actors responded; the requested planes are
  **covered**; each actor returned a **valid plane-tagged** benchmark receipt (`workload-trend@1`, plane matching
  the actor's declared plane); and **all actors ran the SAME benchmark identity** — the `launchIdentity` of
  LBA-REQ-072 (`sha256` over `{ metric, workload, n }`), REUSED as the cross-actor agreement invariant. It fails
  closed on too few actors, a duplicate actor, an uncovered plane, an invalid receipt, an identity disagreement,
  or a tampered digest.
- **It composes, it does not duplicate:** the actor identity comes from the mesh registry model (LBA-REQ-039), the
  dispatch/claim/return framing from provider-delegation (LBA-REQ-018), and the benchmark identity from
  LBA-REQ-072. LBA-REQ-073 is strictly the **fulfillment proof** + the committed run.
- The committed receipt seals a **real** run: a dispatched `labview-ide-launch` benchmark fulfilled by the two
  golden-VM actors — `golden-linux` (LINUX, ~2604 ms) and `golden-win` (WIN, ~2410 ms) — each returning its real
  plane-tagged launch-trend receipt (embedded inline), both covering the requested `[LINUX, WIN]` planes with an
  agreeing identity. The verifier re-derives fulfillment + the digest DETERMINISTICALLY (no VM / network / central
  DB at gate time).

## Consequences

- **The §8 mesh metric is realized + governed:** a dispatched cross-plane run, fulfilled by >= 2 independent
  plane-tagged actors, proven fail-closed — the North Star loop, with zero central data hoarding.
- **A new actor joins by returning a `workload-trend@1` for the dispatched `benchmarkId`** with an agreeing
  identity; its plane extends the coverage automatically. Any benchmark family that emits a plane-tagged receipt
  with a `{ metric, workload, n }` identity plugs in.
- **Next Phase-3 increment (flagged):** the GitHub-native DISPATCH transport — a `repository_dispatch` workflow
  that fans a run request out to volunteer actors and collects their returned receipts as Actions artifacts, whose
  output this fulfillment verifier then gates. This ADR governs the fulfillment PROOF; the dispatch transport is
  the natural follow-on.
- The gate is DETERMINISTIC + offline, consistent with the rg-free / tool-free CI constraint. Authored under the
  singular-requirement directive (one `shall`).
