# labview-benchmark-actor — Test Plan

> Standards baseline: `repo-standards-review` v0.2.19. Test planning follows
> ISO/IEC/IEEE 29119-2 (test processes) and 29119-3 (test documentation). This
> is a planned approach; no test results are claimed until implementation.

## Test approach

- **Deterministic first.** Pure logic (cursor→time mapping, time→picture
  indexing, run-result schema, bus message framing/ordering) is covered by
  fast, host-independent unit tests.
- **Transport integration.** The TCP/UDP bus is exercised with in-process /
  loopback peers before any multi-VM run.
- **Host-native / deployment.** Install and multi-VM behavior is validated on
  the real Codespace and Vagrant targets (maintainer-run; not a hosted CI gate).
- **Traceability.** Every `LBA-REQ` maps to at least one test item below
  (29119-3 test-case-to-requirement traceability).

## Test items

| ID | Requirement | Level | Approach |
| --- | --- | --- | --- |
| T-001 | LBA-REQ-001 | Build/package | Package the `.vsix`; assert no `vi-history-suite`-private module on the dependency graph; verify the moved-module manifest matches the packaged surface. |
| T-002 | LBA-REQ-002 | Deployment | Install the same artifact on a Codespace and a Vagrant golden VM; assert activation first-run signal on both; assert prerequisite checks fire with remediation when a prerequisite is absent. |
| T-003 | LBA-REQ-003 | Unit + integration | Validate a run result against its schema; assert metrics and pictures share one run clock; assert reproducibility within the documented variance bound. |
| T-004 | LBA-REQ-004 | Unit (viewer logic) + browser | Pointer and keyboard drag map to a selected time within bounds; Home/End jump to run start/end; selected time updates continuously; no out-of-range selection. |
| T-005 | LBA-REQ-005 | Unit (indexing) + browser | Nearest-at-or-before rule resolves the correct picture index; moving the cursor updates the picture in lockstep; the "no frame at this time" state renders when appropriate. |
| T-006 | LBA-REQ-006 | Deployment | Spawn N VMs from the declarative topology; assert each activates with a unique identity and publishes results; assert clean teardown leaves no orphaned listeners/locks. |
| T-007 | LBA-REQ-007 | Integration | TCP delivers ordered claim/handoff/ack/done/results; UDP presence/time-sync beacons flow; a dropped UDP beacon does not corrupt TCP-ordered state; a dropped TCP peer is detected; a late joiner reconstructs session state; no path touches `github.com` at run time. |
| T-008 | LBA-REQ-008 | Static / CM | Assert `README.md` and `docs/cm/cm-plan.md` name `repo-standards-review` v0.2.19 (commit `d44f210d`); assert the `docs/` lane layout matches the standards runner; assert requirement IDs are unchanged after a simulated move. |

## Browser / UI validation

- The cursor and picture-panel behavior is verified in a real browser
  (headless is acceptable) over a synthetic run result, mirroring the parent
  repo's preview-viewer harness practice — assert cursor tracking, keyboard
  paging, synchronized picture updates, and the no-frame state, not just
  Node-level logic. `[Assumption]` browser harness stays out of hosted CI (it
  ships as a maintainer harness), consistent with `vi-history-suite`.

## Entry / exit criteria (29119-2)

- **Entry:** the run-result schema and bus message schema are frozen for the
  slice under test.
- **Exit:** every `LBA-REQ` under the slice has a passing deterministic test;
  transport and deployment items are validated on the real targets and recorded
  as maintainer evidence.
