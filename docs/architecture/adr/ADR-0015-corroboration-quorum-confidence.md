# ADR-0015: Corroboration quorum + graded confidence

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-024, ADR-0014 (Actor Corroboration Grid umbrella); builds on LBA-REQ-014 (cross-plane digest anchor)

## Context

The umbrella decision ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) established that a quorum of witnesses
gates a release, but left the quorum arithmetic unspecified: how confidence is scored, how heterogeneous
witnesses — which cannot all satisfy every anchor — are combined, the pass threshold, and the failure action.
The repo already grades a 0–1 confidence over image-derived timing
([experiments/corroboration-confidence-reference.mjs](../../../experiments/corroboration-confidence-reference.mjs));
the quorum generalizes that idea across witnesses.

## Decision

- **Graded confidence** — the corroboration confidence is the fraction `matched / applicable` anchor dimensions,
  computed under the tiered anchor model: OS-independent anchors (viewer `seriesHash`, `lbabus` version +
  `sourceCommit`, gate-suite `verdict`) apply to every witness; Linux-only anchors (pinned `pngSha256`, Ubuntu
  codename) apply only to the Linux subset; capability / host / timestamp are recorded, never scored.
- **Majority threshold** — the quorum passes only when a **majority** of participating witnesses (≥2 of the
  initial 3) agree on their applicable OS-independent anchors **and** the graded fraction meets a configured
  threshold.
- **Fail action** — a sub-majority or below-threshold result **blocks** the release and **auto-opens a divergence
  issue** naming the dissenting witness and anchor.

This is requirement **LBA-REQ-024**.

## Consequences

- Heterogeneous witnesses compose without penalizing the Windows plane for lacking Linux-only anchors.
- One witness outage or dissent is tolerated (majority, not unanimity), so the grid degrades gracefully.
- A failure is actionable: the divergence issue names exactly what disagreed.

## Alternatives considered

- **Unanimous agreement.** Rejected: no tolerance for a single outage; a flaky witness would block every release.
- **Binary pass/fail (no graded score).** Rejected: discards the confidence signal the repo already computes.
- **Put `pngSha256` in the OS-independent tier.** Rejected: cross-OS pixels legitimately differ; it stays a
  Linux-subset anchor (and a witness for the Windows plane).
