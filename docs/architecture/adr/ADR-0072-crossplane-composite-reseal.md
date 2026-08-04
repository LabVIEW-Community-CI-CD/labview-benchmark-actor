# ADR-0072: Genuine cross-plane composite release decision — the fuller 1.0.0 re-seal (LBA-REQ-090)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("I confirm i want the fuller composite re-seal ... sign it") + agent
- Relates to: LBA-REQ-090 (realized here), LBA-REQ-070 / ADR-0051 (the composite release decision pattern — REUSED), LBA-REQ-089 / ADR-0071 (the signed crossPlane machine corroboration — the MACHINE gate), LBA-REQ-057 / ADR-0037 (the signed reviewer visual verdict — the HUMAN gate), LBA-REQ-069 / ADR-0050 (the net-staged candidate), LBA-REQ-086 / ADR-0067 (byte-reproducible `.vsix` — reviewed == shipped)

## Context

LBA-REQ-089 re-sealed the **machine** corroboration (a genuine crossPlane quorum + an enrolled sign-off). But the
shipped 1.0.0's **composite** release decision (ADR-0051 — the capstone that binds the machine gate to the human
visual gate over one net-staged candidate) still stood on the *single-plane* quorum. The operator asked for the
fuller re-seal.

The extension **runtime** (`src`/`out`/`media` + every contributed command/activation) is **byte-identical** from
the originally-reviewed 1.0.0 (`1054b07`) through the crossPlane quorum commit (`2a0352c`); only the byte-repro
build tooling and governance changed. So the reviewer's original genuine visual review (`run-1785842247349`)
applies — this is a genuine **re-bind of the same reviewed runtime** to the byte-reproducible (ADR-0067),
cross-plane corroborated candidate, not a different extension.

## Decision

- **A deterministic visual-verdict signing helper** (`reviewer-workstation/sign-visual-verdict.mjs`) lets the
  reviewer sign a `reviewer-verdict@1` over a staged candidate target with their LOCAL Ed25519 key — replacing the
  net-drive ceremony (which timed out).
- **The genuine crossPlane composite** (`reviewer-workstation/composite-release-decision-crossplane-receipt.json`)
  is assembled via the REUSED composite verifier (`composite-release-decision.mjs`) from: the MACHINE gate = the
  crossPlane quorum (LBA-REQ-088) + the enrolled machine sign-off (LBA-REQ-089); the HUMAN gate = a signed
  `WINDOWS_VM` visual PASS of the byte-reproducible candidate (vsix `2ec7bd31` @ `2a0352c`); and the genuine WIN
  net-staged frame — all five bindings hold, the quorum is `crossPlane`, and both gates are signed by the enrolled
  `reviewer@vi-tech.nl`.
- **Prove + guard it offline.** `crossplane-composite-reseal.selftest.mjs` proves the committed crossPlane composite
  validates as a proven composite decision AND its quorum is crossPlane, while the shipped single-plane composite is
  the defect it corrects (gate `acg-crossplane-composite-reseal`).

## Consequences

- **The 1.0.0 composite is genuinely cross-plane, human-reviewed, and byte-reproducible.** For the first time the
  capstone release decision stands on a two-plane machine quorum + a signed visual verdict + WIN staging, all bound
  to one byte-reproducible candidate — reviewed == shipped across planes.
- **It is non-destructive.** The genuine crossPlane composite is a NEW receipt; the shipped single-plane
  `composite-release-decision-receipt.json` is left frozen (the flagged historical defect). Tightening
  `verify-composite-release` to REQUIRE `crossPlane` (which rejects the frozen single-plane composite) and
  collapsing the frozen file is the operator-gated final step.
- **Nothing is synthesized.** Both the machine and visual sign-offs are the reviewer's local-key acts
  (operator-authorized "sign it"); the agent never forged a signature. Authored under the singular-requirement directive.
