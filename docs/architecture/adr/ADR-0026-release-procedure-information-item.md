# ADR-0026: Make the signed, corroborated release procedure a gated 15289 information item

- Status: Accepted
- Date: 2026-08-02
- Deciders: standards audit (2026-08) via `repo-standards-review` v0.2.19 (deeper clause-level pass)
- Relates to: LBA-REQ-036, ADR-0025 (generated test report + status accounting), ADR-0022 (transparency log + verify-before-install), ADR-0016 (provenance/attestation), ADR-0010 (GitFlow)

## Context

The deeper clause-level audit checked the repo against ISO/IEC/IEEE 15289's
distinction between a *plan* and a *procedure*. The repo had a configuration
management **plan** (`docs/cm/cm-plan.md`) and a 12207 **move/transition
procedure**, but **no release procedure** — the step-by-step execution of a
signed, corroborated release. The actual release flow existed and was enforced,
but only as scattered fragments: branch governance in the CM plan, the
bidirectional agreement gate (LBA-REQ-020), keyless attestation (LBA-REQ-025),
the transparency log and verify-before-install (LBA-REQ-031). A new releaser had
no single procedure to follow, and any prose procedure would drift the moment a
workflow was renamed.

## Decision

- **Author the release procedure as a first-class 15289 information item**
  (`docs/release/release-procedure.md`): release branch → version bump → `--no-ff`
  merge to `main` → corroboration quorum → bidirectional WIN ↔ LINUX agreement →
  keyless signing (cosign / Fulcio / public rekor) → transparency-log inclusion →
  immutable GitHub Release → verify-before-install → merge back.
- **Ground every step in the real enforcement point** — the actual workflow,
  script, gate, or requirement that enforces it — so the procedure documents the
  apparatus rather than an aspiration.
- **Gate it fail-closed.** `experiments/release/verify-release-procedure.mjs`
  asserts that every workflow / script / action path the procedure cites resolves
  on disk, and that the procedure names every required release invariant; wired as
  `release-procedure-references-resolve` with a self-test that also proves a
  missing cited file or a dropped invariant is rejected.
- **Register it (15289)** in the information item map and the correspondence graph.

This is requirement **LBA-REQ-036**.

## Consequences

- The release process is now a single, followable, resolvable procedure — not
  tribal knowledge scattered across the CM plan and grid requirements.
- The procedure cannot silently rot: renaming or deleting a cited release workflow
  or script fails the build until the procedure is updated, the same
  current-by-construction guarantee the generated test report (ADR-0025) and the
  26514 information set (ADR-0024) already enjoy.
- The 15289 procedure/report gap the deeper audit found is closed: the repo now
  carries a release *procedure* (execution) alongside its CM *plan* (policy) and
  its generated test *report* (outcomes).
