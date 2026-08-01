# ADR-0016: Provenance and attestation for the corroboration grid

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-025, ADR-0014 (Actor Corroboration Grid umbrella); complements LBA-REQ-020 (bidirectional release sign-off)

## Context

The umbrella decision ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) requires the quorum verdict to be signed
and attestable, but left open the signing mechanism (the witnesses are heterogeneous — a codespace/Actions node
has an OIDC identity; the VirtualBox VM and Windows box do not), what exactly is attested, where provenance
lives, and how it is verified at consumption.

## Decision

- **Hybrid signing** — sigstore **keyless** where an OIDC identity exists (codespace / Actions); **enrolled
  per-witness keypairs** for the VirtualBox and Windows nodes.
- **Attest the whole chain** — each witness's receipt bundle (signed by that witness's identity), the aggregated
  quorum verdict, the release artifacts (the `.vsix` and the `lbabus` binary), and the human sign-off.
- **Store provenance redundantly** — attached to the GitHub Release (the attested bundle), a committed summary
  in the repo, a sigstore transparency log (rekor) for tamper-evidence, and a ledger over the `lbabus` mesh.
- **Verify before consume** — a standalone verify tool, and the same verification wired into the
  reviewer-workstation install, so a release is not installed until its attestation chain verifies.

This is requirement **LBA-REQ-025**.

## Consequences

- No unattested release is consumable; a forged or altered bundle fails verification.
- Each heterogeneous node signs with an identity it can actually hold (OIDC or an enrolled key).
- Tamper-evidence is external (rekor), not self-asserted.

## Alternatives considered

- **Uniform keyless signing for all witnesses.** Rejected: the VirtualBox and Windows nodes have no OIDC identity.
- **GPG / minisign only.** Rejected: no transparency log; harder to verify provenance independently.
- **Attest only the aggregated verdict.** Rejected: leaves the per-witness bundles and the release artifacts
  unsigned, so a tampered artifact could ride a valid verdict.
