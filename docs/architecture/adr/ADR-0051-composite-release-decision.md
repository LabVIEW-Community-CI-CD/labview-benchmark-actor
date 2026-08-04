# ADR-0051: Composite release decision — bind the machine corroboration gate to the human visual gate over one net-staged candidate (LBA-REQ-070)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03: the capstone — a release publishes only when the machine quorum AND the human PASS agree on the same net-staged candidate) + agent
- Relates to: LBA-REQ-070 (realized here), ADR-0018 / LBA-REQ-027 (`gateReleasePublish`, the MACHINE corroboration gate — REUSED), ADR-0037 / LBA-REQ-057 (`gateVisualReview`, the HUMAN visual gate — REUSED), ADR-0050 / LBA-REQ-069 (the release-with-review DRIVE that stages + binds the candidate over net), ADR-0049 / LBA-REQ-068 (the net-only stage), `gateReleaseWithReview` (`experiments/handoff-beacon/release-with-review.mjs`, the composer — REUSED)

## Context

`gateReleaseWithReview` already ANDs the two release gates: the MACHINE corroboration (`gateReleasePublish` —
a corroboration-grid quorum verdict + an enrolled human sign-off over that quorum, ADR-0018) and the HUMAN visual
verdict (`gateVisualReview` — an enrolled signed PASS of the built candidate, ADR-0037). But it ANDs two
INDEPENDENT decisions: nothing checks that the machine quorum, the human visual verdict, and the net-staged
candidate name the SAME candidate. The machine quorum verdict (`acg-quorum-verdict-v1`) carries a
`consensus.version` + `consensus.sourceCommit`; the visual verdict carries a `target` (component/version/commit/
vsixSha256); LBA-REQ-069 records the net-STAGED candidate. In principle a machine PASS of candidate A could be
ANDed with a human PASS of candidate B and published — the composite decision was not candidate-bound.

## Decision

- **Govern the composite release decision as LBA-REQ-070** with a committed, fail-closed receipt
  (`reviewer-workstation/composite-release-decision-receipt.json`, schema
  `composite-release-decision-receipt@1`) + a pure, rg-free verifier (`composite-release-decision.mjs`) + a
  selftest (7/7) + the gate **`composite-release-decision`**.
- The verifier **REUSES `gateReleaseWithReview`** (which composes `gateReleasePublish` + `gateVisualReview`) and
  adds the **cross-gate candidate binding**: (1) the machine quorum `consensus.version` + `consensus.sourceCommit`
  name the candidate; (2) the human visual verdict `target` names the candidate (all four fields); (3) the
  candidate was STAGED over `net` by a matched `WIN` drive (LBA-REQ-068/069). A release is proven ONLY when both
  gates publish AND all three bindings hold. No signing or gating logic is reimplemented.
- The receipt seals one real round: the ext 0.5.0 candidate, a passing corroboration quorum (2 witnesses
  concurring, `consensus.version` 0.5.0 + the candidate `sourceCommit`) with an enrolled sign-off over the quorum
  digest, AND an enrolled signed visual PASS of the same candidate, AND the net staging drive. One reviewer signs
  both gates with one enrolled Ed25519 key; the private key is ephemeral (never committed), the public key +
  signatures are sealed so the composite gate re-verifies DETERMINISTICALLY (no VM / network / live human).

## Consequences

- **A release publishes only when the machine AND the human agree on the SAME net-staged candidate** — you cannot
  machine-PASS one candidate and human-PASS another. This is the capstone binding over LBA-REQ-027 (machine),
  LBA-REQ-057 (human), and LBA-REQ-068/069 (net stage), each proven in isolation.
- **No gate is reinvented:** the machine quorum + sign-off, the visual verdict + sign-off, and their composition
  all reuse the existing modules; LBA-REQ-070 is strictly the cross-gate candidate binding + the committed round.
- **Re-capture is scripted:** a corroboration-grid quorum verdict + an enrolled sign-off (ADR-0018) + a signed
  visual verdict (ADR-0037) + a net staging drive (ADR-0049/0050) for one candidate compose into `buildReceipt`.
  A future release = a new candidate identity + fresh quorum/visual sign-offs + a fresh staging drive.
- The gate is DETERMINISTIC + offline, consistent with the rg-free / tool-free CI constraint. The authoritative
  artifact attestation remains the release cosign bundle; this receipt governs the composite decision + its
  candidate binding. Authored under the singular-requirement directive (one `shall`).
