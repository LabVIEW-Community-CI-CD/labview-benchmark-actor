# Definition of Done (DoD Gate / dod)

This document is the **Definition of Done** for `labview-benchmark-actor`: the objective,
re-runnable conditions a change must satisfy before it is considered releasable. It is the
release-readiness contract enforced by the **DoD Gate / dod** status context
(`.github/workflows/dod.yml`) and self-certified by the dependency-free local gate suite
(`experiments/verify-local-gates.mjs`, check `dod-definition-present`).

Nothing in this file reproduces standards text. Standards are referenced by identifier and
clause/topic only; the source PDFs are licensed and kept **local** (never committed).

## Standards basis (reference only)

The Definition of Done is derived from, and traceable to, these information sources:

- **ISO/IEC/IEEE 29119-2:2021** — test planning defines scope, entry criteria, and **exit /
  completion criteria**, with evidence retained for completion (Clause 7 dynamic test
  processes; test completion criteria, §3.2). Our "Verification" and "Evidence" exit items
  below implement this.
- **ISO/IEC/IEEE 29148:2018** — requirements **traceability** (RTM linking requirements to
  verification, §3.1.23–3.1.24). Our "Traceability" exit item implements this.
- **ISO/IEC/IEEE 12207:2017** — software life-cycle **process outcomes** must be achieved and
  evidenced before a work product is complete. Our exit criteria are the per-change outcomes.
- **ISO/IEC/IEEE 15289:2019** — required **life-cycle information items** (the SRS, RTM,
  architecture, CM plan, test plan, user guide) are present and current.
- **ISO 10007:2017** — configuration management: **baselines and status accounting** (GitFlow
  governance, ADRs, the CM plan). Our "Configuration" exit item implements this.
- **ISO/IEC/IEEE 42010:2022** — an **architecture description** exists and is current. Our
  "Architecture" exit item implements this.

## Entry criteria

A change may enter the release-readiness check when:

1. It targets `develop` (feature branches) or `main` (release) per GitFlow (ADR-0010, CM plan).
2. It is scoped to a requirement or ADR, or is an explicitly-scoped experiment under `experiments/**`.
3. It builds locally (`npm ci` where applicable) with no new lint/type errors it introduces.

## Exit criteria (the Definition of Done checklist)

A change is **Done** only when every applicable item below is satisfied. Each item maps to a
concrete, machine-checkable gate or retained artifact — this is what makes the DoD objective
rather than aspirational.

| # | DoD condition | Standards ref | Enforced by |
| - | ------------- | ------------- | ----------- |
| 1 | **Verification** — the authoritative local gate suite is green (all `check(...)` pass). | 29119-2 (exit criteria); 12207 (outcomes) | `node experiments/verify-local-gates.mjs` (this DoD Gate runs it) |
| 2 | **Test coverage** — the committed Cobertura artifact meets the parametrized floor. | 29119-2/3 | `coverage-artifact-meets-floor` + `PR Coverage Gate / coverage` |
| 3 | **Traceability** — every requirement resolves to a CodeRef and a TestID; the RTM is consistent. | 29148 (traceability) | `reqs-coverage` gate; `docs/requirements/rtm.csv` |
| 4 | **Configuration** — GitFlow branch governance is honored; ADRs record significant decisions; the CM plan is current. | 10007 (baselines / status accounting) | `gitflow-branch-governance-documented`; `docs/cm/cm-plan.md`; `docs/architecture/adr/**` |
| 5 | **Architecture** — the architecture description reflects the change. | 42010 | `docs/architecture/overview.md` |
| 6 | **Information items** — the required life-cycle documents remain present and current. | 15289 | `docs/requirements/srs.md`, `rtm.csv`, `docs/testing/test-plan.md`, user guide |
| 7 | **Evidence** — the change retains re-runnable proof (experiment receipts / self-tests), not prose claims. | 29119-2 (retained completion evidence) | committed receipts under `experiments/**`; verify-local-gates receipt |

## Enforcement

- **DoD Gate / dod** (`.github/workflows/dod.yml`) publishes the status context and fails the
  change if the local gate suite is not green — i.e., if any exit criterion above is unmet.
- `experiments/verify-local-gates.mjs` check **`dod-definition-present`** statically verifies
  that this document exists, carries the `DoD Gate / dod` marker, enumerates entry/exit
  criteria, and is wired to the DoD Gate workflow — so the Definition of Done cannot silently
  drift or disappear.

A change that satisfies every applicable exit criterion above has met the **DoD Gate / dod**
and is releasable.
