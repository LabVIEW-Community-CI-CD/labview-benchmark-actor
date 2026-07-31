# labview-benchmark-actor — Configuration Management Plan

> Standards baseline: `repo-standards-review` **v0.2.19** (commit `d44f210d`).
> CM follows ISO 10007 (configuration management) and ISO/IEC/IEEE 12207
> (life-cycle processes). This governs the labview-benchmark-actor package now
> that it lives in its own dedicated repository (graduated from the
> `vi-history-suite` prototype subtree).

## Configuration items

| CI | Item | Baseline control |
| --- | --- | --- |
| CI-1 | Specification package (`prototype/labview-benchmark-actor/**`) | This CM plan |
| CI-2 | Standards baseline stamp (`repo-standards-review` v0.2.19) | Bumped only with a coordinated re-validation |
| CI-3 | Requirement IDs (`LBA-REQ-NNN`) | Stable; never renumbered on move |
| CI-4 | Run-result schema, bus message schema | Versioned contracts (frozen per test slice) |

## Branch governance — GitFlow (ISO 10007 §5, ISO/IEC/IEEE 12207)

labview-benchmark-actor has graduated from the `vi-history-suite` prototype
subtree into this dedicated repository and adopts **GitFlow** as its
branch-governance doctrine (LBA-REQ-016; ADR-0010). `main` is the protected
production branch, `develop` is the integration branch, and the CI-owned SemVer
tag on `main` remains the sole publish authority (GitFlow never weakens it).

- Feature branches are created from `develop` and merge back into `develop` through a reviewed pull request; the feature branch is deleted after merge.
- Release branches are cut from `develop`, then merged into `main` and merged into `develop`; delete the release branch after both merges complete.
- Hotfix branches are created from `main`, then merged into `main` and merged into `develop` (or the active `release/*` branch when one is open), and deleted after the required merges complete.
- Releases are SemVer-tagged (`vX.Y.Z`) on `main`; the tag is CI-owned and triggers publish (`collab-cli-vX.Y.Z` for the CLI; the extension release for the `.vsix`).
- On the tagged release path CI re-runs the full verification suite and retains its coverage evidence, so coverage is retained on every release tag.

## Standards-release stamp (ISO 10007 identification)

- `repo-standards-review` release: **v0.2.19**
- Commit: `d44f210d`
- Validation gate to re-run on move or bump:
  `python3 scripts/pipeline.py validate-skill`
- The stamp is recorded in `README.md` and here; the two must stay in sync.

## Move / graduation procedure (12207 transition)

1. Create the `labview-benchmark-actor` repository.
2. Move `prototype/labview-benchmark-actor/**` to the new repo root, preserving
   the `docs/` lane layout so the standards runner resolves every lane.
3. Carry `LBA-REQ` IDs unchanged (CI-3) so external traceability survives.
4. Re-run the `repo-standards-review` validation against the stamped baseline
   (v0.2.19) — or bump the stamp in `README.md` + this plan together and
   re-validate.
5. Retire or redirect the extracted origin in `vi-history-suite` per the
   moved-module manifest (LBA-REQ-001).
6. Record the move (source commit, target repo, standards result) as closeout
   evidence.

## Documentation link checking (ISO 15289)

- Documentation links are validated with **lychee** (a *docs link check*). The
  workflow is seeded at `.github/workflows/docs-link-check.yml` (job
  `Docs Link Check / lychee`, scanning `docs/**/*.md` and `**/*.md`).
- While the package lives under `prototype/labview-benchmark-actor/**` it is a
  subtree, so the seeded workflow is **dormant**; it activates automatically
  when the package moves to its own repository root (LBA-REQ-008, move step 2).
- No passing link-check run is claimed as evidence here — only the configured,
  move-ready gate.

## Status accounting

- Change to any CI is recorded on the discussion thread with the affected
  `LBA-REQ` IDs and the resulting standards-lane impact.
- The information item map (`docs/information-item-map.md`) is reviewed whenever
  a CI changes.
