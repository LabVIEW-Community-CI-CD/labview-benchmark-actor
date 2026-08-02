# Information Item Map

> Standards baseline: `repo-standards-review` v0.2.19. Information items follow
> ISO/IEC/IEEE 15289.

## Scope

- Product or service: labview-benchmark-actor
- Repository: LabVIEW-Community-CI-CD/labview-benchmark-actor (standalone)
- Baseline: prototype specification baseline (planning)
- Owner: maintainers

## Information Items

| Item Type | Current Path | Owner | Trigger | Proving Evidence |
| --- | --- | --- | --- | --- |
| Specification Package Overview | `README.md` | Maintainers | scope, standards-baseline, or move-status change | standards-release stamp and lane links stay resolvable |
| Software Specification | `docs/requirements/srs.md` | Maintainers | benchmarking, UI, transport, or install-route change | active `LBA-REQ` IDs and criteria stay current |
| Architecture Description | `docs/architecture/overview.md` | Maintainers | topology, transport, or view/decision change | viewpoints and decisions trace to `LBA-REQ` IDs |
| Test Plan | `docs/testing/test-plan.md` | QA/maintainers | validation approach or coverage change | each `LBA-REQ` maps to at least one test item |
| Configuration Management Plan | `docs/cm/cm-plan.md` | Maintainers | baseline, branch, release, or move-procedure change | CM plan names the governing standards release and move procedure |
| User Guide | `docs/information-for-users/user-guide.md` | Maintainers | install route or benchmark-UI change | guide covers install, run, the time-cursor review workflow, multi-VM coordination, MCP tools, and release corroboration |
| Requirements Traceability Matrix | `docs/requirements/rtm.csv` | Maintainers | requirement, test, or code-reference change | every `LBA-REQ` maps to a test + code refs; Proven rows resolve on disk (reqs-coverage) |
| Generated Traceability Matrix | `docs/requirements/traceability-matrix.md` | Maintainers (generated) | any requirement / test / view / decision source change | regenerated from the sources; the `traceability-matrix-current` gate fails closed on drift |
| Cross-Plane Benchmark Grid | `docs/benchmarks/benchmark-grid.md` | Maintainers (generated) | a new benchmark, plane, or cross-plane receipt | regenerated from the committed per-benchmark cross-plane receipts; the `cross-plane-benchmark-grid` gate (`LBA-REQ-050`) fails closed on drift or a determinism violation |
| Roadmap | `docs/roadmap.md` | Maintainers | North Star, phase, or near-term-slice change | the multi-year vision + near-term personal-golden-VM slice trace to `ADR-0023` / `LBA-REQ-033` |
| Information for Users (26514 set) | `docs/information-for-users/navigation-and-search.md` | Maintainers | a new command, audience, task, or delivery surface | the bounded ISO/IEC/IEEE 26514 product set is complete + command-covering; the `information-for-users-26514` gate (`LBA-REQ-034`) fails closed on drift |
| Test & Assurance Report | `docs/testing/test-report.md` | Maintainers (generated) | any gate / correspondence-rule / requirement / ADR / coverage-floor change | the ISO/IEC/IEEE 29119-3 executed evidence + ISO 10007 status accounting are regenerated from the apparatus; the `test-report-current` gate (`LBA-REQ-035`) fails closed on drift |
| Release Procedure | `docs/release/release-procedure.md` | Maintainers | a release workflow, signing, corroboration, or verify-before-install change | the step-by-step signed, corroborated release; the `release-procedure-references-resolve` gate (`LBA-REQ-036`) fails closed if a cited enforcement point stops resolving or a release invariant is dropped |
| Compliance Posture | `docs/compliance/compliance-posture.md` | Maintainers (generated) | any lens evidence (information item / wired gate / clause anchor) change | the five-lens rubric self-audit reports 25/25; the `continuous-compliance-self-audit` gate (`LBA-REQ-037`) fails closed if any lens drops below target |

## Notes

- Prefer live repo-relative paths over external links so the pack works in a
  clone and in hosted browsing.
- Review this map whenever requirements, architecture views, or the move status
  change.
- This is planning material: no runtime code or CI is claimed as proving
  evidence until the package graduates to its own repository.
