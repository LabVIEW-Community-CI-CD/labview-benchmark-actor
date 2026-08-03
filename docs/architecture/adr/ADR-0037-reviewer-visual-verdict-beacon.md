# ADR-0037: Reviewer Visual Verdict Beacon — the human's PASS/FAIL becomes a signed release input

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08, PR4 direction: verdict binds to the release candidate + evidence; Ed25519 in the VM now + keyless cosign counter-sign in CI; a new reviewer-verdict@1 mapping to acg-human-signoff-v1; full wiring into gateReleasePublish + release-agreement) + agent
- Relates to: LBA-REQ-057, ADR-0035 (Handoff Beacon Protocol — parent), ADR-0036 (agent→human request), ADR-0018 (human sign-off gate, LBA-REQ-027), ADR-0016 (enrolled Ed25519 attestation, LBA-REQ-025), tools/collab-cli/release-agreement.json

## Context

The reviewer VM exists, above all, for the **human's VISUAL PASS/FAIL** of an extension release
**candidate** — does the built `.vsix` look and work right? PR1–3 made the capture, the
time-cursor correlator, and the agent↔human handoff steps machine-observable. But the **verdict
itself** — the thing the whole reviewer gate is for — was still informal: a "looks good" in chat
or a manually edited `release-agreement.json` signoff. The repo already had the *machine* side
(`acg-reviewer/sign-off.mjs`, a human sign-off over the machine quorum; `acg-provenance/attest.mjs`,
enrolled Ed25519) and CI keyless cosign — but nothing bound the reviewer VM's **actual visual
review** to a signed, governed artifact, and keyless cosign needs GitHub OIDC (CI-only; the VM is
verify-only).

## Decision

Introduce the **reviewer visual verdict beacon** (`reviewer-verdict@1`) — the verdict tier of the
Handoff Beacon Protocol. The human renders a **PASS / CHANGES / FAIL** on a specific candidate
(`{ component, version, commit, vsixSha256 }`) with **evidence pointers** (the capture runs / peak
frames), and **signs it IN the VM** with an **enrolled Ed25519 reviewer key** — no OIDC, so it
works headless. Built by the pure, **dependency-free**, gated `reviewerVerdict.mjs` (staged into
the extension's `media/`, `handoff-verdict` gate):

- `buildReviewerVerdict` / `validateReviewerVerdict` — the rich candidate-bound verdict, fail-closed.
- `signReviewerVerdict` — maps the verdict to an **`acg-human-signoff-v1`** (the existing human
  sign-off schema) bound to the verdict's canonical digest; a `pass` is an `approve`.
- `verifyReviewerVerdict` — fail-closed against the enrolled reviewer allowlist.
- `gateVisualReview` — publishes only on a `pass` verdict with ≥ minReviewers verified enrolled
  approvals; `release-with-review.mjs`'s `gateReleaseWithReview` **composes** it with the ADR-0018
  `gateReleasePublish`, so the machine corroboration AND the human's PASS of the actual candidate
  are **independently required**.

Wiring: the extension's **Render Reviewer Verdict** command signs the verdict in the VM and writes
it to `handoff/verdicts/`; `reviewer-workstation/render-verdict.sh` sets the review target and
collects the signed verdict; `tools/collab-cli/verify-visual-review.mjs` gates a release's
`visualReview` block against the committed `reviewer-allowlist.json` (layered on top of
`verify-release-agreement.mjs`); and CI **keyless-cosign counter-signs** the verdict bundle for a
transparency-logged record.

## Consequences

- **The human gate becomes governed.** The reviewer's visual PASS/FAIL — the reason the reviewer VM
  exists — is now a signed, fail-closed, verifiable input to the release flow, not a chat message.
- **Signable headless, in the VM.** Enrolled Ed25519 needs no OIDC, so the verdict is signed where
  the human is (the VM); keyless cosign layers on in CI where an OIDC identity exists.
- **Composes, does not replace.** It reuses the existing human-sign-off schema + gate + enrolled-key
  primitives, and sits alongside the plane agreement (`release-agreement.json`); neither the machine
  quorum nor the visual verdict substitutes for the other.
- **Roadmap.** The last tier posts the completion/verdict to the `lbabus` coordination bus so remote
  actors see the reviewer's verdict (its own governed slice).
