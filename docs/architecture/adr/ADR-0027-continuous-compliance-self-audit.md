# ADR-0027: Self-audit the five-lens standards posture at clause-evidence granularity, gated 25/25 fail-closed

- Status: Accepted
- Date: 2026-08-02
- Deciders: standards audit (2026-08) via `repo-standards-review` v0.2.19 (deeper clause-level pass — capstone)
- Relates to: LBA-REQ-037, ADR-0013 (enforced 42010 correspondence graph), ADR-0024 (26514 information for users), ADR-0025 (generated test report + status accounting), ADR-0026 (release procedure)

## Context

Two audit passes converged on the same meta-finding. The coarse five-lens audit
scored the repo 25/25 but flagged **F4**: the substantive risk is *non-gated
conformance* — a score that is true today can silently rot tomorrow when a new
command ships undocumented, a gate is unwired, or an information item is deleted.
The deeper clause-level pass then remediated the concrete gaps it found (a 26514
information set — ADR-0024; a generated test report + status accounting —
ADR-0025; a gated release procedure — ADR-0026). What remained was F4 itself, for
**all** standards, not just the ones with a bespoke gate: the *posture* was
asserted, never continuously verified.

## Decision

- **Encode the rubric as executable clause-evidence.** For each of the five
  lenses (REQ/29148, ARCH/42010, TEST/29119, CM/10007-12207, DOC/15289-26514),
  `experiments/compliance/verify-compliance-posture.mjs` lists the concrete
  evidence its rubric level-5 requires: the real information items (SRS, RTM, test
  plan + report, CM plan + release procedure, information item map, 26514 set),
  the wired fail-closed gates that enforce them, and the standard clause anchors
  (fit criteria, stakeholder/concern, completion criteria, baseline, status
  accounting).
- **Score and generate a scorecard.** The self-audit scores each lens and writes
  `docs/compliance/compliance-posture.md` — a per-lens evidence checklist —
  deterministically, so `--check` is a stable drift gate.
- **Gate it fail-closed at 25/25.** `continuous-compliance-self-audit` fails the
  build if any lens drops below its target: delete an information item, unwire a
  gate, or drop a clause anchor and CI goes red. The self-test proves the scoring
  fails closed on any single missing item.
- **Register it (15289)** in the information item map and the correspondence graph.

This is requirement **LBA-REQ-037**.

## Consequences

- F4 is closed for **all** standards, not just the individually-gated ones: full
  compliance is now *corroborated by construction* — re-scored on every change —
  rather than asserted at a point in time.
- The deep-compliance artifacts become load-bearing: the generated test report
  (ADR-0025) and release procedure (ADR-0026) are required clause-evidence in the
  TEST/CM/DOC lenses, so removing them fails the self-audit. The capstone locks in
  the whole remediation program.
- The rubric and the repo cannot silently diverge: because the lens evidence is
  checked against real files and real wired gates, a regression in the apparatus
  is a regression in the score, and the build refuses it.
