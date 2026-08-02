# Compliance posture — labview-benchmark-actor

> GENERATED + fail-closed self-audit (LBA-REQ-037) by
> `experiments/compliance/verify-compliance-posture.mjs`. Scores this repository against the
> `repo-standards-review` five-lens rubric (REQ/ARCH/TEST/CM/DOC) at clause-evidence granularity. The
> `continuous-compliance-self-audit` gate fails closed if any lens drops below its target or a required
> clause-evidence item / wired gate is missing, so full compliance is verified **continuously** and
> cannot silently regress. Do NOT edit by hand — run the generator and commit.

## Posture: 25/25 — CONFORMANT

| Lens | Standard | Score | Target | Evidence |
| --- | --- | --- | --- | --- |
| REQ | ISO/IEC/IEEE 29148 | 5 | 5 | 9/9 |
| ARCH | ISO/IEC/IEEE 42010 | 5 | 5 | 7/7 |
| TEST | ISO/IEC/IEEE 29119-2/3 | 5 | 5 | 7/7 |
| CM | ISO 10007 / ISO/IEC/IEEE 12207 | 5 | 5 | 9/9 |
| DOC | ISO/IEC/IEEE 15289 / 26514 | 5 | 5 | 9/9 |

Each lens reaches its target only when **every** clause-evidence item below is present — a real
information item, a wired fail-closed gate, or a standard clause anchor. Removing any one fails the
build.

## Required clause-evidence per lens

### REQ — ISO/IEC/IEEE 29148 (5/5)

- [x] requirement specification (SRS) — `docs/requirements/srs.md`
- [x] requirements traceability matrix (Req->Test->Code) — `docs/requirements/rtm.csv`
- [x] generated traceability artifact — `docs/requirements/traceability-matrix.md`
- [x] requirement IDs — `docs/requirements/srs.md`
- [x] fit / acceptance criteria (verifiability) — `docs/requirements/srs.md`
- [x] singular-requirement enforcement (29148 §5.2.5) — `gate: requirements-quality-29148`
- [x] Req->Code evidence resolves on disk — `gate: rtm-proven-rows-cite-existing-evidence`
- [x] traceability generated + drift-gated — `gate: traceability-matrix-current`
- [x] Req<->Test correspondence (TR-1) — `gate: test-requirement-correspondence`

### ARCH — ISO/IEC/IEEE 42010 (5/5)

- [x] architecture description — `docs/architecture/overview.md`
- [x] decision register (retained rationale) — `docs/architecture/adr/README.md`
- [x] at least the 4 architecture views — `docs/architecture/overview.md`
- [x] named stakeholders — `docs/architecture/overview.md`
- [x] stakeholder concerns — `docs/architecture/overview.md`
- [x] ADR decision-register integrity — `gate: adr-index-integrity`
- [x] enforced 42010 correspondence graph (AD-1/VW-1) — `gate: test-requirement-correspondence`

### TEST — ISO/IEC/IEEE 29119-2/3 (5/5)

- [x] test plan (29119-3) — `docs/testing/test-plan.md`
- [x] test report — executed evidence (29119-3) — `docs/testing/test-report.md`
- [x] coverage thresholds — `coverage-thresholds.json`
- [x] completion / exit criteria (29119-2) — `docs/testing/test-plan.md`
- [x] PR Coverage Gate (threshold enforced) — `gate: coverage-artifact-meets-floor`
- [x] test report current + drift-gated — `gate: test-report-current`
- [x] test<->requirement (TR-1) — `gate: test-requirement-correspondence`

### CM — ISO 10007 / ISO/IEC/IEEE 12207 (5/5)

- [x] configuration management plan — `docs/cm/cm-plan.md`
- [x] release procedure (12207 release process) — `docs/release/release-procedure.md`
- [x] release workflow — `.github/workflows/extension-release.yml`
- [x] configuration baselines (10007) — `docs/cm/cm-plan.md`
- [x] status accounting (10007) — `docs/cm/cm-plan.md`
- [x] SemVer identification — `docs/cm/cm-plan.md`
- [x] complete GitFlow branch governance — `gate: gitflow-branch-governance-documented`
- [x] CM status accounting (CM-1) — `gate: adr-index-integrity`
- [x] release procedure resolvable + invariant-complete — `gate: release-procedure-references-resolve`

### DOC — ISO/IEC/IEEE 15289 / 26514 (5/5)

- [x] 15289 information item map — `docs/information-item-map.md`
- [x] doc-type: specification — `docs/requirements/srs.md`
- [x] doc-type: plan — `docs/testing/test-plan.md`
- [x] doc-type: report — `docs/testing/test-report.md`
- [x] doc-type: procedure — `docs/release/release-procedure.md`
- [x] 26514 information-for-users set — `docs/information-for-users/navigation-and-search.md`
- [x] docs link-check (lychee) — `.github/workflows/docs-link-check.yml`
- [x] 26514 bounded product set gated — `gate: information-for-users-26514`
- [x] information-item coverage (II-1/II-2) — `gate: test-requirement-correspondence`

_Self-audited across 41 clause-evidence checks over 5 lenses._
