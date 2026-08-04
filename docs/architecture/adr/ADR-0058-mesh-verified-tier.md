# ADR-0058: The opt-in verified tier — enrolled-actor attestations bind a returned receipt to a real actor (LBA-REQ-077)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "trust, but verify: attest actor receipts") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-077 (realized here), LBA-REQ-076 / ADR-0057 (the fan-out collection this tier hardens), LBA-REQ-025 / ADR-0016 (the acg-provenance enrolled-key attestation engine reused here — `signBundle` / `verifyWitnessAttestation`), LBA-REQ-039 / ADR-0023 (mesh-actor registration — the enrolled actor identities), LBA-REQ-073 (fulfillment — the downstream consumer)

## Context

The fan-out collection (LBA-REQ-076) proves each returned receipt is identity-bound (it ran the dispatched
benchmark) and structurally valid, and the fulfillment gate (LBA-REQ-073) proves enough distinct cross-plane
actors responded. But nothing proves a returned receipt actually came from a REAL enrolled actor: a rogue or
buggy participant could fabricate a plausible `workload-trend@1` for any plane and it would pass the structural +
identity checks. For a public, volunteer mesh with no central server, "the returned receipts ARE the result" only
holds if a receipt is cryptographically bound to the enrolled actor that produced it. The project already has the
machinery — the ADR-0016 acg-provenance enrolled-key attestation engine (`signBundle` / `verifyWitnessAttestation`,
Ed25519, an enrolled `identity → publicKey` allowlist) used for corroboration-witness bundles — so the verified
tier should REUSE it rather than invent new crypto.

## Decision

- **Govern the opt-in verified tier as LBA-REQ-077** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshVerifiedTier.mjs`) + a committed enrolled-keys registry
  (`mesh-actor-keys.json`, public keys only) + a committed verified collection
  (`mesh-run-verified-collection.json`) + a selftest (7/7) + an opt-in verified-tier step in
  `.github/workflows/mesh-run.yml` + the gate `mesh-verified-tier-attested`.
- **Each returned actor receipt is attested** by the actor's ENROLLED Ed25519 key: `attestReturnedReceipt`
  delegates to the ADR-0016 `signBundle`, producing an `acg-witness-attestation-v1` whose subject digest is the
  canonical digest of the exact returned receipt and whose `witnessIdentity` is the actor id. No new crypto.
- **A `verified-receipt-collection@1`** binds a validated LBA-REQ-076 collection (by its digest) to one attestation
  per collected receipt. `validateVerifiedCollection` requires the underlying collection to validate, the verified
  wrapper to bind to it (collection digest + dispatchId + identity), and — for every collected receipt — a valid
  attestation from its DECLARED, ENROLLED actor over the ACTUAL receipt (via `verifyWitnessAttestation` against the
  enrolled allowlist). It fails closed on an unsigned receipt, a forged (post-sign mutated) receipt, an un-enrolled
  actor, a key that does not match the enrolled one, an attestation not by the declared actor, an orphan
  attestation, or a tampered digest.
- **The gate** `mesh-verified-tier-attested` proves, offline + deterministically: the selftest (7/7); the committed
  verified collection re-verifies against the committed collection + enrolled keys (via the CLI); every collected
  receipt is attested by its declared, enrolled actor; and `mesh-run.yml` runs the verified-tier step. The enrolled
  PUBLIC keys are committed; the private keys are not (they stay with each actor VM).

## Consequences

- **A returned receipt is now bound to a real enrolled actor** — a fabricated trend from an un-enrolled or
  impersonating participant is rejected at the verified tier, closing the "any participant can fabricate a receipt"
  gap that the structural + identity checks alone leave open. The mesh can require the verified tier for runs whose
  results feed release decisions.
- **It is opt-in and additive** — a plain fan-out (LBA-REQ-076) still works for low-stakes runs; the verified tier
  is the higher-assurance mode, layered on top without changing the dispatch → tasking → collection → fulfillment
  contracts. The `mesh-run.yml` verified-tier step runs between the fan-out and the fulfillment gate.
- **It reuses the corroboration trust root** — the same ADR-0016 enrolled-key engine that attests
  corroboration-witness bundles now attests mesh-actor receipts, so the mesh inherits a proven, audited signing +
  verification path rather than a bespoke one. Enrolling an actor is publishing its public key to
  `mesh-actor-keys.json`.
- The gate is DETERMINISTIC + offline (no VM / network / private keys at gate time; it verifies committed
  signatures against committed public keys), consistent with the rg-free / tool-free CI constraint. Authored under
  the singular-requirement directive (one `shall`).
