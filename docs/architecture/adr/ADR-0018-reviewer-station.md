# ADR-0018: Reviewer station for the corroboration grid

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-027, ADR-0014 (Actor Corroboration Grid umbrella); complements ADR-0015 (machine quorum)

## Context

The umbrella ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) keeps a human in the loop but left open where the
human reviews and how the sign-off relates to the machine quorum. Today the visual gate is an expert reviewer on
a Windows 11 VM (the reviewer manual test plan); most visual checks render committed benchmark JSON and are
LabVIEW-independent, so they can also run in a browser.

## Decision

- **Dual reviewer station** — the human visual gate runs on **either** the Windows reviewer VM **or** a
  zero-install Linux browser codespace (the reviewer's choice); TC-09 (a live LabVIEW run) stays on the VM until
  the LabVIEW phase.
- **Sign-off is a separate gate** — the recorded, signed human sign-off is layered **on top of** the machine
  quorum: a release publishes only when the machine quorum passes **and** the human sign-off is recorded.
- **Single reviewer now** — architected for a multi-reviewer human quorum later.

This is requirement **LBA-REQ-027**.

## Consequences

- A reviewer with no VM can still serve, lowering the bar to the human gate.
- Human judgment cannot be silently skipped, and it cannot substitute for the machine quorum (both required).

## Alternatives considered

- **Replace the Windows VM entirely.** Rejected: TC-09 needs live LabVIEW until the LabVIEW phase.
- **Fold the human into the machine quorum.** Rejected: a subjective sign-off and a deterministic anchor are
  different evidence; keeping them separate keeps each honest.
