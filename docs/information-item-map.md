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
| User Guide | `docs/information-for-users/user-guide.md` | Maintainers | install route or benchmark-UI change | guide covers install, run, and the time-cursor review workflow |
| Requirements Traceability Matrix | `docs/requirements/rtm.csv` | Maintainers | requirement, test, or code-reference change | every `LBA-REQ` maps to a test + code refs; Proven rows resolve on disk (reqs-coverage) |
| Generated Traceability Matrix | `docs/requirements/traceability-matrix.md` | Maintainers (generated) | any requirement / test / view / decision source change | regenerated from the sources; the `traceability-matrix-current` gate fails closed on drift |

## Notes

- Prefer live repo-relative paths over external links so the pack works in a
  clone and in hosted browsing.
- Review this map whenever requirements, architecture views, or the move status
  change.
- This is planning material: no runtime code or CI is claimed as proving
  evidence until the package graduates to its own repository.
