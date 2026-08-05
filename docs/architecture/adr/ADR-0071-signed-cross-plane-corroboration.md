# ADR-0071: Signed cross-plane corroboration — the genuine two-plane re-seal of the machine corroboration (LBA-REQ-089)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("sign it" — authorized the enrolled reviewer sign-off over the genuine crossPlane quorum, closing the machine half of the 1.0.0 re-seal) + agent
- Relates to: LBA-REQ-089 (realized here), LBA-REQ-088 / ADR-0070 (the durable crossPlane quorum this signs), LBA-REQ-027 / ADR-0018 (`gateReleasePublish` — the machine quorum + enrolled-sign-off gate, REUSED), LBA-REQ-070 / ADR-0051 (the composite release decision this machine corroboration feeds)

## Context

ADR-0070 captured a genuine cross-plane machine quorum (a real linux-plane witness + a real windows-plane witness
that agree over the deterministic anchors) as a committed, tamper-evident attestation. That is the corrected
analogue of the shipped `quorum-1.0.0.json`, whose two witnesses (LINUX + VMware-**Ubuntu**) were **both the linux
plane** — the flagged corroboration defect.

But a machine quorum alone is not the machine *corroboration gate*. The ADR-0018 gate (`gateReleasePublish`) is the
quorum **plus** a recorded, signed sign-off by an enrolled human reviewer over that exact quorum — the sign-off never
substitutes for the quorum; both are independently required. The shipped 1.0.0 had such a sign-off, but over the
**single-plane** quorum. To re-seal the corroboration honestly, the enrolled reviewer must sign over the **genuine
crossPlane** quorum.

That sign-off is signed with the reviewer's enrolled Ed25519 key, which is **local to the reviewer and never
committed**. The agent must not synthesize it. The operator authorized the sign-off ("sign it") using the enrolled
`reviewer@vi-tech.nl` key; the agent produced only the sign-off (public material) via a deterministic, offline
helper — never handling nor committing the private key.

## Decision

- **A deterministic signing helper** (`reviewer-workstation/sign-release-quorum.mjs`) lets the reviewer produce the
  machine sign-off **offline** with their local key — reading the committed crossPlane quorum, signing its
  `bundleDigest`, and emitting the `acg-human-signoff-v1` (public). This replaces the net-drive ceremony (which kept
  timing out) with a single reproducible step; the private key never leaves the reviewer.
- **A signed cross-plane corroboration** (`experiments/acg-quorum/signed-cross-plane-corroboration.mjs`, schema
  `signed-cross-plane-corroboration@1`) REUSES `gateReleasePublish` and adds one requirement on top: the quorum must
  be genuinely `crossPlane` (verdict pass AND spans both os-planes) and its consensus must name the candidate
  (version + sourceCommit). It reimplements no signing/gating and never synthesizes a signature.
- **The committed receipt** (`signed-cross-plane-corroboration-receipt.json`) records the re-seal: extension `1.0.0`
  @ `2a0352c`, the ADR-0070 crossPlane quorum, and the enrolled `reviewer@vi-tech.nl` sign-off over it — verified
  against the committed allowlist. `signed-cross-plane-corroboration.selftest.mjs` (7/7, throwaway key) proves the
  machinery and that a single-plane / non-pass / un-enrolled / forged / unnamed / tampered receipt all fail closed
  (gate `acg-signed-cross-plane-corroboration`).

## Consequences

- **The corroboration defect is genuinely re-sealed on the machine side.** The ACG now holds a committed machine
  corroboration that is BOTH genuinely cross-plane AND carries an enrolled human sign-off over that exact quorum —
  the honest replacement for the single-plane `quorum-1.0.0.json` + its sign-off.
- **No fabricated evidence.** The reviewer's Ed25519 signature is genuine (operator-authorized, enrolled key); the
  agent only assembled + verified public material. The signing path is deterministic + offline, so it is
  reproducible and does not depend on the flaky net-drive.
- **It sets up the enforcement flip + the frozen composite.** The remaining step — tightening
  `verify-composite-release` to REQUIRE `crossPlane`, which correctly rejects the shipped single-plane composite —
  is operator-gated because it changes the shipped 1.0.0's enforcement status. The shipped `witnesses-1.0.0/*` +
  `composite-release-decision-receipt.json` stay frozen until the operator directs the flip. Authored under the
  singular-requirement directive.
