# ADR-0074: Run-bound mesh ingestion — bind a live dispatch + the actors' returned receipts into the fan-out contract (LBA-REQ-091)

- Status: Accepted
- Date: 2026-08-04
- Deciders: the agent-autonomy showcase campaign (operator: "think big, become ambitious, as many turns as you need" — agents operate provisioning + gating + mesh runs end-to-end, toward a real N=2 cross-plane demo) + agent
- Relates to: LBA-REQ-091 (realized here), LBA-REQ-076 / ADR-0057 (the live fan-out contract — REUSED for the tasking + collection gating), LBA-REQ-074 / ADR-0055 (the mesh-run dispatch — REUSED for dispatch validation), LBA-REQ-073 / ADR-0054 (mesh-run fulfillment — the collection's consumer), LBA-REQ-072 / ADR-0053 (the `launchIdentity` bound end-to-end), LBA-REQ-080 / ADR-0061 (the attested mesh-run capstone the ingested collection ultimately feeds)

## Context

The fan-out contract (LBA-REQ-076) governs how a dispatch is expanded into per-plane `actor-tasking@1` and how the
actors' returned receipts are collected into `receipt-collection@1`, both identity-bound to the dispatch — but it is
proven over **committed fixtures** (`mesh-run-tasking.json` / `mesh-run-collection.json`). A **live** mesh run has no
such fixtures: the dispatch arrives as the workflow `client_payload`, and the actors' receipts arrive as returned
run artifacts (agent-driven handoff — a driver runs each VM, collects a signed plane-tagged receipt, and hands the
files back). Nothing governed the step that **ingests** that live dispatch + those returned receipts into the fan-out
contract. Without it, the "live" path is a hand-wave: an agent-driven run could assemble a receipt set outside the
real dispatch and still reach the fulfillment gate. The agent-autonomy campaign's real N=2 cross-plane run needs a
run-bound, fail-closed ingestion seam so the collected set provably descends from the actual dispatch.

## Decision

- **Govern the run-bound ingestion as LBA-REQ-091** with a pure, rg-free module
  (`experiments/mesh-fulfillment/meshIngest.mjs`) + a selftest (8/8) + the gate `mesh-run-ingest`. The module adds
  **no new gating logic** — it is the LIVE data path into the committed fan-out contract.
- **The returned receipt** (`returned-receipt@1`) is the actor-handoff envelope `{ schema, taskId, actorId, plane,
  receipt }`, where `receipt` is the actor's `workload-trend@1`. `readReturned(dir)` reads a folder of sorted
  `returned-receipt@1` files (the artifacts the agent driver hands back); `returnedOk(r)` fails closed on a malformed
  envelope.
- **`ingestRun({ dispatch, returned })`** validates the live dispatch (REUSING `meshDispatch.requestOk` +
  `dispatch.identity === dispatchIdentity(dispatch.benchmark)`, LBA-REQ-074), then REUSES the LBA-REQ-076 fan-out —
  `deriveTasking(dispatch)` → `buildCollection({ tasking, returned })` → `validateTasking` + `validateCollection` — to
  produce a run-bound tasking + collection bound to the `dispatchId`, returning `{ ok, findings, tasking, collection,
  actors }`. It fails closed on: an uncovered requested plane, a declared/receipt plane mismatch, a returned receipt
  whose identity ≠ the dispatched benchmark identity, a receipt bound to an unknown task, a duplicate actor, a
  malformed dispatch, or a malformed returned receipt.
- **The gate** `mesh-run-ingest` proves, offline + deterministically, the selftest (8/8): a genuine two-plane run
  ingests to a two-actor collection, and each fail-closed case above is rejected.

## Consequences

- **The live mesh path is now governed at its ingestion seam** — dispatch (`client_payload`) + returned receipts →
  run-bound tasking + collection → [existing fan-out / verified-tier / transparency / append-only / attested pipeline]
  — with the benchmark identity bound at every hop, so an agent-driven run cannot feed fulfillment a receipt set that
  never descended from the real dispatch.
- **Zero new gating surface.** `meshIngest` reuses the LBA-REQ-074 dispatch validator and the LBA-REQ-076 fan-out
  derive/validate verbatim; the committed fan-out fixtures stay authoritative for CI, and the ingestion seam is what
  the agent driver feeds real Linux + Windows launch receipts through in the N=2 live run.
- **`[Assumption]`** the returned-receipt handoff is trusted transport (the agent driver produces the files); receipt
  **authenticity** (each receipt signed by its enrolled actor) remains the opt-in verified tier's job (LBA-REQ-077 /
  ADR-0058), which runs on the ingested collection — ingestion binds provenance to the dispatch, attestation binds it
  to a real enrolled actor.

## References

- Realizes: LBA-REQ-091 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-091`)
- Reuses: ADR-0057 (fan-out), ADR-0055 (dispatch); feeds ADR-0058/0059/0060/0061 (verified-tier → attested capstone)
- Standards baseline: repo-standards-review (the authoritative standards lens for this repo, ADR-0010)
