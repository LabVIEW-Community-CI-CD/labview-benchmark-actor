# ADR-0059: Transparency-log the mesh-actor attestations — enrolled-signed AND publicly auditable (LBA-REQ-078)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "public auditability: transparency-log the receipts") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-078 (realized here), LBA-REQ-077 / ADR-0058 (the verified tier whose attestations this logs), LBA-REQ-031 / ADR-0022 (the acg-transparency signed-Merkle-log engine reused here — `recordRelease` / `verifyReleaseInclusion` / `verifySignedTreeHead`), LBA-REQ-025 / ADR-0016 (the enrolled-key attestations that become log entries)

## Context

The verified tier (LBA-REQ-077) binds each returned receipt to its enrolled actor with an Ed25519 attestation, so
a fabricated trend from an un-enrolled participant is rejected. But the SET of attestations is not publicly
auditable: a compromised actor key could sign a receipt, and nothing records the attestations in an append-only,
tamper-evident log that a third party can audit. Release provenance already solved exactly this problem — the
ADR-0022 acg-transparency engine records witness attestations into an RFC-6962 signed Merkle tree and admits an
artifact only when its attestation carries an inclusion proof against the signed tree head (verify-before-install).
The mesh should REUSE that engine so mesh-actor receipts are not just enrolled-signed but publicly auditable, with
no new log machinery.

## Decision

- **Govern the mesh transparency layer as LBA-REQ-078** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshTransparency.mjs`) + a committed enrolled log-key
  (`mesh-log-key.json`, public key only) + a committed logged collection
  (`mesh-run-logged-collection.json`) + a selftest (7/7) + a transparency step in
  `.github/workflows/mesh-run.yml` + the gate `mesh-attestations-transparency-logged`.
- **Each verified-tier attestation becomes a log entry**: `buildLoggedCollection` delegates to the ADR-0022
  `recordRelease`, which builds the Merkle tree over the attestation entry leaves, signs the tree head with the
  enrolled log key, and emits a per-attestation inclusion proof. No new log crypto.
- **A `logged-verified-collection@1`** binds a validated LBA-REQ-077 verified collection (by its digest) to the
  signed tree head + one inclusion proof per attestation. `validateLoggedCollection` requires the verified tier to
  hold, the wrapper to bind to it, the signed tree head to verify against the enrolled log key, and — for every
  attestation — a valid inclusion proof against that signed root (via `verifyReleaseInclusion`). It fails closed on
  an unsigned or wrong-key tree head, a missing or non-reconstructing inclusion proof, a tree-size mismatch, a
  verified-collection binding mismatch, or a tampered digest.
- **The gate** `mesh-attestations-transparency-logged` proves, offline + deterministically: the selftest (7/7); the
  committed logged collection re-verifies (signed tree head + every inclusion proof) via the CLI; the tree logs
  every attestation with an inclusion proof; and `mesh-run.yml` runs the transparency step. The enrolled log PUBLIC
  key is committed; the private key is not.

## Consequences

- **Mesh receipts are now enrolled-signed AND publicly auditable** — verify-before-consume requires BOTH the
  actor's witness signature (LBA-REQ-077) and an inclusion proof in a signed transparency log (this ADR), matching
  the release-provenance trust model. A third party can audit that a given attestation was logged, and the
  append-only Merkle structure makes silent removal or substitution detectable.
- **It reuses the release transparency root** — the same ADR-0022 signed-Merkle-log engine that logs
  corroboration-witness attestations now logs mesh-actor attestations, so the mesh inherits a proven RFC-6962
  inclusion-proof path rather than a bespoke one. A future consistency proof between successive tree heads (the
  engine already provides `consistencyProof` / `verifyConsistency`) extends this to an append-only history.
- **It is additive on top of the verified tier** — the `mesh-run.yml` transparency step runs after the verified
  tier and before the fulfillment gate; a run that does not opt into the verified tier simply has nothing to log.
- The gate is DETERMINISTIC + offline (no network / log operator / private key at gate time; it verifies committed
  inclusion proofs against a committed signed tree head + public key), consistent with the rg-free / tool-free CI
  constraint. Authored under the singular-requirement directive (one `shall`).
