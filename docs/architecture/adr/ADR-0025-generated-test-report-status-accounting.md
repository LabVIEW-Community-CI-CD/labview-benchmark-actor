# ADR-0025: Generate the 29119-3 test report + ISO 10007 status accounting from the verification apparatus

- Status: Accepted
- Date: 2026-08-02
- Deciders: standards audit (2026-08) via `repo-standards-review` v0.2.19 (deeper clause-level pass)
- Relates to: LBA-REQ-035, ADR-0013 (enforced 42010 correspondence graph), ADR-0024 (govern 26514 information for users)

## Context

The coarse five-lens audit scored the repo 25/25, so a deeper, clause-level pass
was run against `repo-standards-review`'s per-standard clause research. It found
subtler gaps the rubric could not see. Two are concrete and adjacent:

- **ISO/IEC/IEEE 29119-3 (test documentation):** the repo keeps a test *plan*
  (`docs/testing/test-plan.md`, the design of what to test) but no test *report* —
  the executed outcomes. The apparatus runs (130+ fail-closed gates, a
  correspondence graph, a coverage gate) but nothing recorded the *result* as a
  governed information item.
- **ISO 10007 / ISO/IEC/IEEE 12207 (configuration status accounting):** the CM
  plan *describes* status accounting, but no artifact *records* the controlled
  state of the configuration items (requirements by status, ADRs, gates, test
  items).

A hand-written report or status log would immediately drift from the apparatus it
claims to describe — the same failure mode the 26514 audit finding (ADR-0024)
flagged for user information.

## Decision

- **Generate the report, do not hand-write it.**
  `experiments/reqs-coverage/generate-test-report.mjs` derives, from the canonical
  committed sources, into `docs/testing/test-report.md`:
  - the **29119-2 completion criteria** (a change is complete when every governed
    gate passes fail-closed on both platforms; no manual override);
  - the **29119-3 executed verification evidence** (the full fail-closed gate
    inventory, the correspondence rules, the coverage floors, the extension
    suites);
  - the **ISO 10007 configuration status accounting** (requirements by status,
    ADRs, gates, correspondence rules, and test items — the controlled state).
- **Make it deterministic** (no timestamps, no git HEAD) so `--check` is a stable
  drift gate, mirroring the generated traceability matrix (ADR-0013 Stage 3).
- **Gate it fail-closed.** `test-report-current` runs the self-test, which proves
  the committed report is current, that rendering is deterministic, and that the
  drift compare fails closed on any mutation.
- **Register it (15289)** in the information item map and the correspondence graph.

This is requirement **LBA-REQ-035**.

## Consequences

- The repo now carries the two information items that a deeper clause audit
  expects (a test *report*, not only a test *plan*; a status-accounting *record*,
  not only a CM plan) — and they cannot silently lag the apparatus, because a
  drift fails the build.
- The report and the traceability matrix become the two generated, drift-gated
  views of the same correspondence graph: what is *verified* and how it *traces*.
- Assurance is corroborated by construction: the executed-evidence and
  status-accounting record are re-derived on every change rather than trusted.
