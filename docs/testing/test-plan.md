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
| T-007 | LBA-REQ-007 | Integration | TCP delivers ordered claim/handoff/ack/done; UDP presence beacons flow; a dropped UDP beacon does not corrupt TCP-ordered state; a dropped TCP peer is detected; a late joiner reconstructs session state; no path touches `github.com` at run time; assert the bus carries **inter-actor communication only** — no run data, run/frame metadata, or images. |
| T-008 | LBA-REQ-008 | Static / CM | Assert `README.md` and `docs/cm/cm-plan.md` name `repo-standards-review` v0.2.19 (commit `d44f210d`); assert the `docs/` lane layout matches the standards runner; assert requirement IDs are unchanged after a simulated move. |
| T-009 | LBA-REQ-009 | Integration | Assert captured pictures are written to the VM-local mprr **long-packet** ring buffer and their index/timestamp to the **short-packet** stream (per mprr ADR-0024); assert the run-result frame `ref` resolves against the local mprr review-capture store; assert **nothing from the ring buffer crosses the bus** (the bus is inter-actor comms only). |
| T-010 | LBA-REQ-010 | Integration + static | Assert the viewer operates over the actor's own local run history (no cross-VM read, no run data on the bus); assert completed runs are concentrated to the operator's host by an explicit out-of-band step (not the bus); assert the host-side ollama comparison layer consumes the concentrated corpus. |
| T-011 | LBA-REQ-011 | Unit (deterministic logic) | Build the correlation over a synthetic CPU/RAM/disk series with a pre/post trigger; assert each sample maps to the correct frame index (null before frame zero), the trigger resolves to a frame index, samples split pre/post correctly, and each metric's pre/post window (count/mean/min/max) and post-minus-pre delta are correct; assert null counters are skipped and invalid input fails closed. |
| T-012 | LBA-REQ-012 | Deterministic (embed round-trip) | Assert `lbabus agents` emits the version-pinned base instructions embedded in the binary and that `agents --out`/`--check` round-trip (embedded == source, exit 0); assert a tampered copy is detected as drift (exit 3). Gated on every release by the `ci-agents` harness stage; the reqs-coverage check (`experiments/reqs-coverage/verify-reqs-coverage.mjs`) enforces that this row's cited evidence resolves. |
| T-013 | LBA-REQ-013 | Deterministic (mock case) | Assert the priority + addressing envelope: `post --priority` stamps a flat `prio` tier (P0>P1>P2>P3, default P2) and the sender's `agentId`; `poll`/`wait --to-me` keeps only broadcast-or-self-addressed messages and drops other-plane traffic; `poll`/`wait --min-priority` keeps only messages at least that urgent. Assert back-read-compat: a flat additive envelope parses through the real `CollabMessage.TryParse` while a nested-object envelope and a `schema@v2` bump each silently drop. Gated by the `fixture-priority` mock cases (`linux-to-me-recipient-filter`, `linux-min-priority-triage-filter`, `linux-envelope-flat-additive-back-read-compat`) in the ci harness. |
| T-014 | LBA-REQ-014 | Deterministic (fixture) + maintainer (cross-plane) | Assert the mprr short-ring core is deterministic and has teeth (`verify-mprr-ring` 9/9: ring write/wrap/zero-copy-view, overwrite fail-closed, blockId + boundary-variation, admission fail-closed, deterministic authoritative ingest, jittered non-authoritative, non-monotonic rejection, viewer-series projection determinism). Assert the store pairs two planes' runs of a shared `benchmarkId` and reports numeric `deltas` + a `digests` section where the deterministic `seriesHash` matches (`match:true`) and the per-plane screenshot `pngSha256` is a witness (`match:false`), failing closed on a single-plane compare (`verify-benchmark-store` 6/6). Gated by local gates #27 (`benchmark-store-receipt-green`, asserts the seriesHash matches cross-plane) and #28 (`mprr-short-ring-model-green`). Maintainer cross-plane evidence: each plane runs `node playwright/screenshot.mjs` + `node experiments/benchmark-store/register-mprr-run.mjs`; PROVEN 2026-07-31 — a real WIN Node run (win32/x64, Node v22.15.0) independently produced the identical deterministic `seriesHash` and `cross-plane-comparison-proven-green` gates the cross-plane match + zero metric deltas. The synthetic identical-to-LINUX WIN `pngSha256` placeholder was removed; the per-plane WIN screenshot visual witness is a pending maintainer step (browser, non-CI). |
| T-015 | LBA-REQ-015 | Deterministic (fixture) + maintainer (real report) | Assert `summarizeViAnalyzerReport` is deterministic + ORDER-INDEPENDENT (`verify-vi-analyzer-result` 6/6: counts + verdict, order-independent resultHash, all-pass, resultHash-tracks-content, benchmark-metrics projection, rejects invalid result + duplicate viPath). Gated by local gate #30 (`vi-analyzer-result-model-green`). The Windows clean room installs the toolkit (`cleanroom/docker-windows/install-vi-analyzer.ps1`, PR #72). Maintainer real-report evidence: a plane runs `LabVIEWCLI RunVIAnalyzer`, the report is summarized, and the `resultHash` compared cross-plane; Proven when a real report is summarized on both planes and the `resultHash` matches. |
| T-016 | LBA-REQ-016 | Static / CM | Assert `docs/cm/cm-plan.md` states the GitFlow feature/release/hotfix branch rules (feature from and back into `develop`; release from `develop`, merged to `main` and `develop`, then deleted; hotfix from `main`, merged to `main` and `develop`), SemVer tags on `main`, and coverage retained on the tagged release path; assert `docs/architecture/adr/ADR-0010-gitflow-branch-governance.md` records the decision. Mirrors the authoritative `repo-standards-review` CM gate (all 9 GitFlow signals + SemVer + coverage-on-release), which reports `cm` PASS. Gated by `gitflow-branch-governance-documented` in `verify-local-gates`. |
| T-017 | LBA-REQ-017 | Deterministic (offline) | Assert the committed `dep-manifest.json` passes the verifier, and that the verifier FAILS CLOSED on each defect class (bad schema, malformed SHA, unknown plane, missing python bitness, bad `pinStatus`, resolved-but-empty version), while allowing `tbd-*` pins to omit their concrete value. Gated in `verify-local-gates`. |
| T-018 | LBA-REQ-018 | Deterministic (offline, mock adapter) | Assert the delegation harness end-to-end via the mock provider (no GPU / no network): `lba-uplift-task@v1` validation accepts a good task and rejects bad schema/domain; the provider seam returns the `{provider,model,text,ms,ok}` contract; the acceptance gate passes a good draft and FAILS a weak one; the receipt matches `lba-uplift-delegation-receipt@v1`; the registry routes a `CLAIM` only to a live capability-matched worker; the worker pool bounds concurrency; and each uplift domain (coverage-lift, evidence, risky-test, vipm-gate, vipm-routing) gates fail-closed. Gated in `verify-local-gates`. |
| T-019 | LBA-REQ-019 | Deterministic (offline, host-free) | Assert the MCP surface across three legs (no real VS Code, no display, no live `lbabus`): the pure JSON-RPC handler answers `initialize` / `tools/list` / `tools/call` and returns `-32601` / `-32602` for an unknown method / tool; `activate()` registers the MCP provider under the SAME id the manifest contributes; and the spawned stdio entry round-trips `initialize` + `tools/list` + `tools/call` (deterministic `get_benchmark_series`) over newline-delimited JSON-RPC. The bundled `scripts/mcpToolDoc.mjs --check` keeps `docs/mcp-tools.md` in sync. Gated in `npm test`. |

## Browser / UI validation

- The cursor and picture-panel behavior is verified in a real browser
  (headless is acceptable) over a synthetic run result, mirroring the parent
  repo's preview-viewer harness practice — assert cursor tracking, keyboard
  paging, synchronized picture updates, and the no-frame state, not just
  Node-level logic. `[Assumption]` browser harness stays out of hosted CI (it
  ships as a maintainer harness), consistent with `vi-history-suite`.

## Test coverage (PR Coverage Gate)

Test coverage is measured with **c8** (V8 coverage) and enforced by the **PR Coverage Gate**
(`.github/workflows/coverage.yml`, status context `PR Coverage Gate / coverage`): `npm run test:coverage`
runs the suite under c8, emits a **Cobertura** `coverage/cobertura-coverage.xml` (the retained coverage
artifact), and FAILS below the line-coverage **threshold** (fail-under). The thresholds are parametrized in
`coverage-thresholds.json` (the single knob) and RATCHET upward gradually -- `npm run coverage:bump` raises
each floor toward the measured coverage by at most `step`, capped at `target`, and never lowers a floor.
Adoption floors: lines/statements 70%, functions 58%, branches 45% (measured 73/73/62/49%). Gated locally by
`coverage-artifact-meets-floor` in `verify-local-gates`.

## Local CI/CD verification (local gate)

Local CI/CD **is** testing for this package: the retained experiment receipts
and the RTM `Proven` evidence are re-validated by a real, re-runnable pass/fail
gate rather than trusted as static files.

- **Gate:** `node experiments/verify-local-gates.mjs` (dependency-free ESM). It
  asserts the bus-prototype receipt is green (12/12), the OCR-primitive engine
  is available with byte-exact readback, the shared retained inputs
  (`ground-truth-ledger.json`, `surface-metadata.json`) are present, every
  RTM `Proven` row cites an existing evidence path, and the CPU/RAM/disk
  resource-usage correlation receipt is green (LBA-REQ-011). Exit code is
  non-zero on any failure.
- **Cross-platform by design.** The seeded workflow
  `.github/workflows/lba-local-gates.yml` runs the gate on **both** a
  `linux-native` and a `windows-native` runner. That parity is the near-term
  horizon — linux-native mirroring the same mprr **ring-buffer** read/replay
  capability windows-native has (best effort). The ring-buffer read/replay path
  is already cross-platform (the mprr `ReviewCaptureTransportReader` targets
  `net8.0` plain, build-proven on windows-native); only surface render and the
  `Windows.Media.Ocr` image-derived-timing production remain windows-bound.
- The workflow is **dormant** while the package is a subtree and activates at
  the standalone repository root (LBA-REQ-008, `docs/cm/cm-plan.md` move step 2).

## Entry / exit criteria (29119-2)

- **Entry:** the run-result schema and bus message schema are frozen for the
  slice under test.
- **Exit:** every `LBA-REQ` under the slice has a passing deterministic test;
  the local CI/CD gate (`experiments/verify-local-gates.mjs`) is green on both
  runners; the deterministic-logic suites enforce a line-coverage **threshold**
  of at least 75% (`fail-under` 75% in local CI/CD) once the actor logic is
  implemented; transport and deployment items are validated on the real targets
  and recorded as maintainer evidence.
