# ADR-0070: Durable genuine cross-plane corroboration attestation — capture the live two-plane proof as a committed, tamper-evident receipt (LBA-REQ-088)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("you are supposed to be prescriptive, do not take shortcuts" — stop hedging the re-seal into a dry-run and DRIVE the genuine machine corroboration) + agent
- Relates to: LBA-REQ-088 (realized here), LBA-REQ-087 / ADR-0069 (the live two-plane proof this makes durable), LBA-REQ-024 (the quorum), LBA-REQ-026 / ADR-0068 (os-plane independence), LBA-REQ-070 / ADR-0051 (the composite release decision whose HUMAN half stays the reviewer's local-key act)

## Context

ADR-0069 produces a genuine windows-plane witness and a genuine linux-plane witness in CI and proves — live — that
they cross-plane corroborate. But that proof is **ephemeral**: it exists only inside a workflow run. Nothing
**committed** consumed a genuine windows-plane witness, so the ACG's committed evidence still only had the honest
single-plane negative from ADR-0068 (the DEV grid is codespace + host-linux — one plane). The shipped `1.0.0`
corroboration remained a flagged defect: its `quorum-1.0.0.json` claims `distinctEnvironments: true` over a LINUX
witness and a VMware-**Ubuntu** witness — **both the linux plane**.

The genuine machine-side fix is now available and requires no manual VM: the ADR-0069 workflow, on its `push:
[develop]` trigger, produced a real `os: linux` witness (ubuntu-latest) and a real `os: windows` witness
(windows-latest) at one develop commit. Those two genuine witnesses can be **captured durably** and quorum-compared
offline — the corrected analogue of the defective single-plane quorum.

The **human** half of a full release re-seal — an enrolled Ed25519 sign-off over the quorum plus a signed visual
verdict (`composite-release-decision`, LBA-REQ-070) — is signed with the reviewer's private key, which is **local
to the reviewer and never committed** (`enroll-reviewer.mjs`). That signature is deliberately **not** synthesized:
forging it would defeat the entire corroboration. This ADR delivers the honest MACHINE corroboration; the human
sign-off stays the reviewer's cryptographic act.

## Decision

- **A durable attestation** (`experiments/acg-quorum/cross-plane-attestation.mjs`, schema
  `cross-plane-corroboration-attestation@1`) embeds the two GENUINE CI witnesses, records their **provenance** (the
  workflow, run id + url, commit), re-derives the os-plane quorum (`compare-witnesses.mjs`), and is
  CROSS-PLANE CORROBORATED only when that quorum PASSES **and** spans both os-planes (`crossPlane`). A recursive
  canonical digest makes it tamper-evident.
- **The committed receipt** (`cross-plane-attestation-receipt.json`) captures the ubuntu-latest (linux) +
  windows-latest (windows) witnesses at develop `2a0352c` from run `30923501292` — verdict PASS, confidence 1,
  `crossPlane`, anyone can re-download the run artifacts and byte-compare.
- **Prove + guard it offline.** `cross-plane-attestation.selftest.mjs` proves the committed attestation validates
  and that every fail-closed guard fires — most importantly that a **single-plane set (the 1.0.0 defect: two linux
  witnesses) is NOT accepted** as corroboration — and the gate `acg-cross-plane-attestation` re-derives the quorum
  and asserts the committed attestation is genuinely cross-plane with recorded provenance.

## Consequences

- **The genuine cross-plane corroboration is now durable + committed, not just live.** The ACG has, for the first
  time, a committed machine corroboration built from a real windows plane and a real linux plane — the honest
  machine half of the 1.0.0 re-seal, and the template its eventual human-signed re-seal will reuse.
- **The exact 1.0.0 defect is encoded as a fail-closed test.** A two-linux witness set (LINUX + VMware-Ubuntu, as
  the shipped `quorum-1.0.0.json` used) fails the attestation closed, so the defect can never silently recur.
- **The human boundary is explicit + honest.** This ADR stops at the machine corroboration; it does not fabricate
  the reviewer's Ed25519 sign-off. Completing the composite release decision over this quorum (the human visual
  verdict + machine sign-off) remains the reviewer's local-key act, staged but never synthesized. The shipped
  `witnesses-1.0.0/*` + `composite-release-decision-receipt.json` are left frozen (operator-gated). Authored under
  the singular-requirement directive.
