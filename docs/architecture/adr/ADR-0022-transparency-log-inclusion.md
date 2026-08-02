# ADR-0022: Signed Merkle transparency log + verify-before-install

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-031, LBA-REQ-025 (provenance + attestation, ADR-0016), LBA-REQ-023 (Actor Corroboration Grid, ADR-0014)

## Context

[ADR-0016](ADR-0016-provenance-attestation.md) established the enrolled-key attestation chain: each witness
Ed25519-signs its receipt bundle, and `verify-before-consume` re-computes the quorum over the attested
bundles. [LBA-REQ-025](../../requirements/srs.md) additionally requires that provenance be **stored in a
transparency log** and that the **reviewer-workstation install verify the chain before install**. Those two
clauses were the remaining un-shipped, but offline-provable, part of LBA-REQ-025 (the sigstore-keyless OIDC
path and the public rekor network are networked and stay out of scope here).

A transparency log must be **append-only and tamper-evident**: a consumer, holding only a signed tree head
and a small proof, must be able to confirm that a given attestation is recorded in the log without trusting
the log operator and without downloading the whole log.

## Decision

- **Record corroboration provenance in an append-only, Ed25519-signed Merkle transparency log** — the
  self-hosted, offline-verifiable analogue of rekor. Hashing follows **RFC 6962** (Certificate Transparency):
  domain-separated leaves (`SHA-256(0x00 || data)`) and interior nodes (`SHA-256(0x01 || left || right)`) with
  a deterministic largest-power-of-2 split, so the tree shape — and therefore every inclusion and consistency
  proof — is canonical and independently recomputable.
- **The log reuses the enrolled-key trust root** (Ed25519) of ADR-0016 for its **signed tree heads**, not a
  separate PKI, so the grid keeps one trust root. The log private key is held out-of-repo; only its public key
  is enrolled (committed).
- **verify-before-install** (a standalone CLI and the reviewer-workstation provisioner) admits installation
  **only when at least `quorumMin` witnesses each have (1) an attestation signed by an enrolled witness that
  binds to its own bundle, and (2) an inclusion proof placing that attestation in the signed log**. Any
  failure blocks the install (fail-closed).

This is requirement **LBA-REQ-031**.

## Consequences

- Provenance gains an append-only, independently verifiable home: `consistency` proofs show the log was never
  rewritten between two signed heads; `inclusion` proofs show a specific attestation is recorded.
- The reviewer-workstation no longer installs a release on the strength of a verdict alone — an unattested or
  un-logged artifact is refused before the `.vsix` is installed.
- LBA-REQ-025's transparency-log and reviewer-workstation-verify clauses are satisfied offline; its
  sigstore-keyless OIDC and public-rekor clauses remain the networked tier and stay Planned.

## Alternatives considered

- **Adopt a plain Bitcoin-style Merkle tree** (bare `SHA-256(left || right)`, "promote the odd node"), such as
  the referenced [Etelis/Merkle_Tree](https://github.com/Etelis/Merkle_Tree). Rejected for a security-critical
  provenance log: without domain separation an interior node can be presented as a leaf (second-preimage /
  leaf-vs-node confusion), and the odd-node promotion yields a non-canonical shape. RFC 6962 domain separation
  and the power-of-2 split close both. The reference informed the shared construction (leaves → pairwise hash →
  signed root + inclusion proofs); the hardening is the delta.
- **Depend on the public sigstore/rekor network now.** Rejected as the *only* mechanism: it requires network
  and an OIDC identity, so it cannot be gated offline. It remains the complementary networked tier of
  LBA-REQ-025; this ADR delivers the self-hosted, offline-verifiable log.
- **Sign the whole log instead of a tree head.** Rejected: a signed root + per-entry proofs let a consumer
  verify inclusion in O(log n) without the whole log, which a whole-log signature does not.
