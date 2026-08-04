# ADR-0050: Release-with-review drive — bind the net-staged candidate to the signed + announced visual verdict (LBA-REQ-069)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03: build the richer release-with-review drive — the VM stages a candidate, the human signs a visual verdict that gates the release, as one governed loop) + agent
- Relates to: LBA-REQ-069 (realized here), LBA-REQ-068 / ADR-0049 (the net-only live VM drive that STAGES the candidate), LBA-REQ-057 / ADR-0037 (the signed reviewer visual verdict — REUSED), LBA-REQ-058 / ADR-0038 (the verdict bus announcement — REUSED), LBA-REQ-059 / ADR-0039 (the read-back correlation), ADR-0018 (`gateReleasePublish`, the machine gate `release-with-review.mjs` already composes)

## Context

Three governed facts already exist independently: the reviewer VM can STAGE a release candidate over `lbabus net`
(LBA-REQ-068), a human can SIGN a candidate-bound visual verdict with an enrolled Ed25519 key (LBA-REQ-057), and
that signed verdict can ANNOUNCE over `net` with a semantic type (LBA-REQ-058). But NOTHING proved they are the
SAME candidate in one loop: the staging drive, the signed verdict, and the bus announce were separate artifacts,
so — in principle — the VM could stage candidate A, the human sign candidate B, and the bus announce candidate C.
The existing `release-with-review.mjs` (`gateReleaseWithReview`) composes the visual verdict with the MACHINE
corroboration gate (`gateReleasePublish`, ADR-0018); it does not bind the verdict to a NET-STAGED candidate.

## Decision

- **Govern the release-with-review DRIVE as LBA-REQ-069** with a committed, fail-closed receipt
  (`reviewer-workstation/release-with-review-drive-receipt.json`, schema `release-with-review-drive-receipt@1`) +
  a pure, rg-free verifier (`release-with-review-drive.mjs`) + a selftest (7/7) + the gate
  **`release-with-review-drive`**.
- The verifier **REUSES the existing verdict primitives** — `verifyReviewerVerdict`, `gateVisualReview`, and
  `buildVerdictBusPost` from `experiments/handoff-beacon/reviewerVerdict.mjs` — and adds the NEW **binding**:
  1. the candidate was STAGED over `net` by a matched `WIN` drive bound to the same component + version
     (LBA-REQ-068);
  2. the signed verdict's `target` (component/version/commit/vsixSha256) is the SAME candidate;
  3. the sign-off VERIFIES against the enrolled reviewer key and the visual-review gate PUBLISHES (a signed
     PASS, LBA-REQ-057);
  4. the `net` announce is CORRECTLY DERIVED from the signed verdict (type/task/ref, a `WIN` net frame,
     LBA-REQ-058).
- The receipt seals ONE real round (the ext 0.5.0 candidate staged over net, signed PASS by an enrolled reviewer,
  announced `RESOLVED` on `extension-release-0.5.0`). The reviewer private key is ephemeral (used once to sign,
  never committed); the enrolled public key + signature are sealed so the gate re-verifies DETERMINISTICALLY (no
  VM / network / live human), fail-closed on a candidate the verdict did not cover, a sign-off that does not
  verify, a gate that would not publish, a mis-derived announce, or a tampered digest.

## Consequences

- **The whole release-with-review loop is bound to a single candidate over net-only** — you cannot stage one
  candidate, sign another, and announce a third; the release honours the verdict for the candidate that was
  actually staged. This closes the composition gap left by LBA-REQ-057/058/068 (each proven in isolation).
- **No signature scheme is reinvented:** the verdict digest binding, the Ed25519 sign/verify, the enrolled
  allowlist, and the semantic `net` announce all reuse `reviewerVerdict.mjs`. LBA-REQ-069 is strictly the
  BINDING + the committed round.
- **Re-capture is scripted:** `drive-agent-closed-loop.sh` stages a candidate over net; the extension's Render
  Reviewer Verdict command signs it in the VM; `buildReceipt` seals the bound round. A future release = a new
  candidate identity + a fresh signed verdict (the digest re-derives, the gate re-verifies).
- The gate is DETERMINISTIC + offline, consistent with the rg-free / tool-free CI constraint. The authoritative
  artifact attestation (the `.vsix` sha) remains the release cosign bundle; this receipt governs the loop's
  BINDING + gate logic. Authored under the singular-requirement directive (one `shall`).
