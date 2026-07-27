# labview-benchmark-actor — Configuration Management Plan

> Standards baseline: `repo-standards-review` **v0.2.19** (commit `d44f210d`).
> CM follows ISO 10007 (configuration management) and ISO/IEC/IEEE 12207
> (life-cycle processes). This governs the specification package while it lives
> on the prototype branch and through its move to a dedicated repository.

## Configuration items

| CI | Item | Baseline control |
| --- | --- | --- |
| CI-1 | Specification package (`prototype/labview-benchmark-actor/**`) | This CM plan |
| CI-2 | Standards baseline stamp (`repo-standards-review` v0.2.19) | Bumped only with a coordinated re-validation |
| CI-3 | Requirement IDs (`LBA-REQ-NNN`) | Stable; never renumbered on move |
| CI-4 | Run-result schema, bus message schema | Versioned contracts (frozen per test slice) |

## Baseline and branch strategy

- Current baseline: **prototype specification** on
  `prototype/labview-benchmark-actor` (off `vi-history-suite` `develop`
  `bb704bba`).
- The prototype branch is planning material only — no runtime code or CI gate
  is claimed as proving evidence here.
- Coordination for this thread runs on the collaboration bus
  (GitHub Discussion) until the TCP/UDP bus (LBA-REQ-007) exists; the discussion
  thread is the interim status-accounting channel.

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

## Status accounting

- Change to any CI is recorded on the discussion thread with the affected
  `LBA-REQ` IDs and the resulting standards-lane impact.
- The information item map (`docs/information-item-map.md`) is reviewed whenever
  a CI changes.
