# ADR-0052: Enforce the composite release decision in the extension release workflow (LBA-REQ-071)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03: wire the composite decision into the actual release ceremony as an enforced gate) + agent
- Relates to: LBA-REQ-071 (realized here), ADR-0051 / LBA-REQ-070 (the composite release DECISION this ENFORCES), ADR-0037 / LBA-REQ-057 (`verify-visual-review.mjs`, the human gate already enforced in the workflow), the bidirectional agreement (`verify-release-agreement.mjs`), `.github/workflows/extension-release.yml`

## Context

ADR-0051 / LBA-REQ-070 governs the composite release decision (the machine corroboration gate AND the human
visual gate, bound to one net-staged candidate) as a committed fail-closed receipt + a CI gate. But that gate
only proves the PATTERN in the local-gate suite; it does not BLOCK a real `.vsix` publish. The extension-release
workflow already enforces two release-time gates in its `agreement` job — the WIN<->LINUX plane agreement
(`verify-release-agreement.mjs`) and the human visual verdict (`verify-visual-review.mjs`) — and the `release`
(publish) job `needs: [build, agreement]`. The composite decision was not yet in that publish-gating chain, so a
governed decision existed but was not ENFORCED at the point of release.

## Decision

- Add `tools/collab-cli/verify-composite-release.mjs` — a fail-closed release-time enforcement CLI that, for a
  `<component, version>`, requires the committed composite receipt to NAME that candidate AND be a proven
  composite decision. It REUSES the gated `validateReceipt` from the composite-release-decision verifier; no
  gating logic is reimplemented. Exit 0 = cleared to publish; 1 = fail-closed; 2 = usage.
- Wire it into `extension-release.yml`'s `agreement` job (after `verify-visual-review`). Since `release`
  `needs: [build, agreement]`, a failing (or missing) composite decision BLOCKS the publish.
- Govern the enforcement as LBA-REQ-071 with the gate `composite-release-enforced`, which proves (offline,
  deterministic) that the CLI clears the committed candidate (ext 0.5.0) + fails closed for a version with no
  decision, AND that the workflow wires the CLI in the publish-gating agreement job.

## Consequences

- **No `.vsix` publishes without a proven, candidate-bound composite decision for that exact version** — the
  machine corroboration AND the human visual verdict, both naming the released candidate. The three release-time
  gates (plane agreement, visual verdict, composite decision) now ALL gate the publish.
- **Satisfiable + non-disruptive:** the enforcement runs only on `ext-v*` tags / `workflow_dispatch` (not on PR
  CI); the committed composite receipt clears ext 0.5.0; a future release adds its own composite receipt (a new
  candidate identity + fresh machine/visual sign-offs + a fresh staging drive) before it can publish.
- **The enforcement REUSES the composite verifier:** a change to the composite decision's rule propagates to the
  release gate automatically. This completes the release-gate arc — machine quorum (LBA-REQ-027), human visual
  (LBA-REQ-057), net stage (LBA-REQ-068), stage<->sign<->announce binding (LBA-REQ-069), machine+human composite
  binding (LBA-REQ-070), and now the enforced publish gate (LBA-REQ-071). Authored under the singular-requirement
  directive (one `shall`).
