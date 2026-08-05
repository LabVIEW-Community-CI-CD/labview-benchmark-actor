# ADR-0073: Enforce genuine cross-plane on release + collapse the 1.0.0 composite (LBA-REQ-071, LBA-REQ-090)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("b" — collapse: overwrite the frozen composite with the crossPlane one + require crossPlane) + agent
- Relates to: LBA-REQ-071 / ADR-0052 (the composite-release enforcement this tightens), LBA-REQ-090 / ADR-0072 (the genuine crossPlane composite re-seal this finalizes — supersedes its "non-destructive / left frozen" stance), LBA-REQ-088 / ADR-0070 (the crossPlane property now enforced)

## Context

ADR-0072 produced the genuine crossPlane composite as a NEW receipt
(`composite-release-decision-crossplane-receipt.json`), leaving the shipped single-plane
`composite-release-decision-receipt.json` frozen, and flagged the enforcement flip + file collapse as the
operator-gated final step. The operator authorized the collapse ("b").

## Decision

- **Collapse to one composite.** The genuine crossPlane composite REPLACES `composite-release-decision-receipt.json`
  (the defective single-plane 1.0.0 composite); the transitional `-crossplane-` receipt is removed. The old
  single-plane seal is preserved in git history — this is a normal tracked file edit, not a Marketplace re-publish.
- **Enforce cross-plane on release.** `tools/collab-cli/verify-composite-release.mjs` now REQUIRES the composite's
  machine quorum be `crossPlane` (spans both os-planes), so a single-plane composite (the shipped 1.0.0 defect) is
  rejected fail-closed. `crossplane-composite-reseal.selftest.mjs` proves the enforcement CLEARS the crossPlane
  composite and REJECTS a single-plane variant; the `composite-release-enforced` + `acg-crossplane-composite-reseal`
  gates guard it.

## Consequences

- **The committed 1.0.0 composite is genuinely cross-plane, and release enforcement requires it.** The defect cannot
  recur: no composite publishes unless its machine quorum spans both planes (windows AND linux).
- **Supersedes ADR-0072's non-destructive stance** now that the operator authorized the collapse. There is one
  composite receipt again, correct this time; the defective single-plane seal remains in git history for the record.
- **Closes the cross-plane re-seal end to end** — byte-reproducible artifact (ADR-0067), genuine two-plane machine
  quorum (ADR-0069/0070), enrolled machine + human sign-offs (ADR-0071/0072), and now enforced on publish. Authored
  under the singular-requirement directive.
