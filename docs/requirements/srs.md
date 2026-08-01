# labview-benchmark-actor — Software Requirements Specification

> Standards baseline: `repo-standards-review` v0.2.19. Requirements follow
> ISO/IEC/IEEE 29148 §5 (requirement quality: verifiable, unambiguous,
> traceable). Requirement IDs are `LBA-REQ-NNN`; acceptance criteria are cited
> by position as `LBA-REQ-NNN.M`.

## Introduction

`labview-benchmark-actor` is a VS Code extension that extracts the hooking and
agentic infrastructure from `vi-history-suite` into a standalone, installable
package for **benchmarking**. It is installed on a **Codespace** or a **Vagrant
golden VM**, drives benchmark runs through its agentic infrastructure, and
presents results through a **time-cursor benchmark viewer**. Multiple Vagrant
VMs coordinate over a **TCP/UDP bus** rather than a GitHub Discussion.

Assumptions and constraints are marked as such; everything else is a normative
requirement. This is planning material — no implementation is claimed.

**Absorbed model (self-owned):** captured pictures are stored via the **mprr**
ring-buffer model — its bounded-RAM dual-packet ring buffer (dual-packet policy
from mprr ADR-0024) and frozen TDMS-compatible `1.0` replay transport — inside each
VM cleanroom. This model is **absorbed in-repo as dependency-free mirrors** under
`experiments/mprr-ring/`; labview-benchmark-actor owns it and does not track the
external `svelderrainruiz/mprr` repository. The `mprr` name is retained for the local
model (see LBA-REQ-009, ADR-0005, ADR-0009).

The coordination bus carries **inter-actor communication only** (the
GitHub-Discussion replacement); run data never crosses it. Agents do not compare
runs across VMs — each reviews its own previous runs, and the operator
concentrates runs onto the host for an ollama comparison layer (LBA-REQ-010,
ADR-0006).

---

## Requirements (governed register)

Per the `repo-standards-review` requirement directive (ISO/IEC/IEEE 29148:2018
§5.2.5 Singular), each requirement is a single-`shall` row with a measurable Fit
Criterion and a Verification method, validated by
`scripts/requirements_quality_check.py`. The `### LBA-REQ-NNN` sections below
elaborate acceptance detail. Rows are migrated into this governed register
progressively.

| ID | Requirement | Rationale | Fit Criterion | Verification |
| --- | --- | --- | --- | --- |
| LBA-REQ-017 | The system shall record every LabVIEW authoring-lane dependency as a version-pinned entry in a governed dependency manifest. | The authoring lane (`labview_assistant` + its DQMH dependency + the `.vipb` VI-Package build) must build reproducibly on the Windows clean room, which requires every dependency pinned to a concrete, verifiable version rather than a floating reference. | `experiments/labview-authoring/dep-manifest.json` records each authoring dependency with a `pinStatus` of `resolved` (a concrete git SHA, pip version, or vipc) or `tbd-*`, and the verifier rejects a bad schema, a malformed SHA, an unknown plane, a missing python bitness, a bad `pinStatus`, or a `resolved` entry with an empty version. | Run `node experiments/labview-authoring/verify-dep-manifest.mjs` and `verify-dep-manifest.selftest.mjs`; both gated in `verify-local-gates`. |
| LBA-REQ-018 | The system shall delegate a validated uplift task to a capability-matched cleanroom AI provider over the coordination bus. | Uplift and documentation-drafting work runs where the licensed tooling and capability differentiation live (cleanroom actors running Ollama / Copilot CLI / Codex), so the host observes each cleanroom's gated outcome over the existing `lbabus` transport rather than hosting providers centrally. | `delegateUplift` validates an `lba-uplift-task@v1` spec, drives the provider through a provider-agnostic adapter seam, applies a deterministic acceptance gate (pass and fail), and writes an `lba-uplift-delegation-receipt@v1` announced as an ADR-0003 `DONE` frame; the registry routes a `CLAIM` only to a live capability-matched worker; the worker pool bounds concurrency; each uplift domain (coverage-lift, evidence, risky-test, VIPM credential + routing) gates fail-closed — all proven offline via the mock adapter. | Run the provider-delegation verify suite (`verify-provider-delegation`, `verify-registry`, `verify-claim-tasking`, `verify-worker-pool`, `verify-quality-gate`, `verify-vipm-routing`, `verify-vipm-gate`, `verify-coverage-lift`, `verify-evidence`, `verify-risky-test`); gated in `verify-local-gates`. |
| LBA-REQ-019 | The system shall expose the benchmark actor's tools to a coding agent through a Model Context Protocol server. | Coding agents consume tooling through MCP, and the actor already holds value an agent wants (host capabilities, the deterministic mprr benchmark series, and the `lbabus` coordination bus), so a standard MCP surface lets an agent discover and call them directly rather than through bespoke VS Code commands. | The compiled JSON-RPC 2.0 handler answers `initialize` / `tools/list` / `tools/call` over newline-delimited stdio, publishes exactly four tools (`get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`, `post_coordination_note`), returns `-32601` / `-32602` for an unknown method / tool, and degrades a missing `lbabus` to a soft `isError` rather than a transport crash; the definition provider registers under the same id the manifest contributes; and `docs/mcp-tools.md` matches the published registry. | Run `npm test` (compiles, then runs `test/mcp-server.mjs` -- pure-core, activation, and stdio legs -- and `scripts/mcpToolDoc.mjs --check docs/mcp-tools.md`). |
| LBA-REQ-020 | The system shall block a component release from publishing until both the WIN and LINUX planes have recorded an agreed sign-off for that exact component version. | A shared release (the `collab-cli` bus binary or the VS Code extension `.vsix`) is co-owned by both planes, so letting either plane publish unilaterally would ship an unreviewed change; each component's release workflow therefore fails closed until both planes commit an explicit `agreed:true` sign-off for the exact version. | `verify-release-agreement.mjs` reads `tools/collab-cli/release-agreement.json` (`release-agreement@v2`) and exits 0 only when every required plane (WIN, LINUX) records `agreed:true` for the `<component, version>`, exits 1 fail-closed on a missing / withheld / unparseable sign-off, and exits 2 on a usage error; both `extension-release.yml` and `collab-cli-release.yml` run it before their publish job. | Run `node tools/collab-cli/verify-release-agreement.mjs <version>` (and `--component extension <version>`); each release workflow gates its publish job on the gate's exit 0. |
| LBA-REQ-021 | The system shall reject any governed test file that does not correspond to at least one requirement in the traceability register. | A test that maps to no requirement is either an untraceable capability or dead weight; enforcing the test-to-requirement correspondence as a fail-closed gate keeps the 29119 test suite tied to the 29148 requirements and seeds the ISO/IEC/IEEE 42010 correspondence graph (ADR-0013) that later rules extend. | `verify-correspondences.mjs` enumerates the governed test set (`test/*.mjs`, `experiments/**/verify-*.mjs`, `*.selftest.mjs`, `*.playwright.{mjs,cjs}`, `playwright/*.mjs`, `tools/**/verify-*`) from the working tree and exits 1 listing any file absent from every RTM CodeRef (rule TR-1); it also enforces the ADR-to-requirement (AD-1) and requirement-to-view (VW-1) correspondence rules fail-closed after the ADR-0013 register reconciliation. | Run `node experiments/reqs-coverage/verify-correspondences.mjs`; gated in `verify-local-gates`. |
| LBA-REQ-022 | The system shall generate the requirement traceability matrix from the governed requirement, test, and decision sources. | Hand-maintaining the requirement-to-view-to-decision-to-test cross-references invites drift, so deriving one matrix from the canonical SRS, RTM, architecture description, and ADR register keeps the traceability view honest and current by construction (ADR-0013 correspondence graph, Stage 3). | `generate-traceability.mjs` reads the requirement ids and titles from `docs/requirements/srs.md`, the status / TestID / CodeRef count from `docs/requirements/rtm.csv`, the addressing architecture view from `docs/architecture/overview.md`, and the decisions from the ADR index, then writes `docs/requirements/traceability-matrix.md`; `--check` exits non-zero when the committed matrix is stale. | Run `node experiments/reqs-coverage/generate-traceability.mjs --check`; gated by `traceability-matrix-current` in `verify-local-gates`. |
| LBA-REQ-023 | The system shall gate each governed component release on an on-demand corroboration quorum in which a majority of independent witnesses across distinct environments agree on the release's deterministic anchors. | A single cleanroom is an unwitnessed single point of trust; requiring a majority of independent, distinct-environment witnesses to agree on the deterministic anchors raises release confidence and makes a drifted or forged witness detectable as a quorum divergence rather than a silent pass. | The Actor Corroboration Grid (ADR-0014) collects a signed receipt bundle from at least two of three heterogeneous witnesses (Codespace-Linux, VirtualBox-Linux, Windows) and passes only when a majority agree on the OS-independent anchors (viewer `seriesHash`, `lbabus` version + `sourceCommit`, gate-suite `verdict`); a sub-majority blocks the release and opens a divergence issue. | Recorded in ADR-0014; the quorum engine and its per-phase sub-requirements land design-first, each gated in `verify-local-gates` as delivered. |
| LBA-REQ-024 | The system shall pass the release corroboration quorum only when a majority of participating witnesses agree on their applicable OS-independent anchors and the graded anchor-agreement fraction meets the configured threshold. | A single witness is an unwitnessed point of trust; grading agreement across a majority of heterogeneous witnesses tolerates one outage while still requiring genuine cross-environment corroboration (ADR-0015). | The quorum verdict is the fraction `matched / applicable` anchor dimensions under the tiered model; it passes on a >=2-of-3 majority meeting the threshold, and a sub-majority or below-threshold result blocks the release and opens a divergence issue naming the dissenting witness and anchor. | Recorded in ADR-0015; the quorum engine lands in Phase 2 and is gated in `verify-local-gates` as delivered. |
| LBA-REQ-025 | The system shall block consumption of a release artifact until its corroboration attestation chain verifies. | An unattested or tampered artifact must not be installed on the strength of a verdict alone; verifying the signed chain before consumption closes that gap (ADR-0016). | Each witness signs its receipt bundle (sigstore keyless where an OIDC identity exists, an enrolled key otherwise); the aggregated verdict, the release artifacts, and the human sign-off are attested and stored on the Release, in the repo, in a transparency log, and on the mesh ledger; a standalone verify tool and the reviewer-workstation install both verify the chain before install. | Recorded in ADR-0016; the signing and verify tooling land in Phase 3 and are gated as delivered. |
| LBA-REQ-026 | The system shall reject a corroboration quorum whose witnesses do not span distinct enrolled environments. | N identical nodes are not N independent witnesses; requiring distinct enrolled environments prevents one actor from forging agreement with look-alike witnesses (ADR-0017). | A valid quorum spans distinct enrolled environments; a non-enrolled witness or one that duplicates an already-counted environment does not count toward the majority, and each counted witness's identity is recorded in the provenance. | Recorded in ADR-0017; the enrollment and diversity checks land in Phase 3 and are gated as delivered. |

---

### LBA-REQ-001: Standalone extraction of hooking and agentic infrastructure

- Status: Proposed
- Area: Packaging
- Statement: The hooking and agentic infrastructure currently developed on
  `vi-history-suite` `develop`/`prototype` shall be packaged as a **standalone
  VS Code extension** (`labview-benchmark-actor`) with no build- or run-time
  dependency on `vi-history-suite` internals.
- Acceptance Criteria:
  - The extension builds, packages (`.vsix`), and activates without any
    `vi-history-suite`-private module on its dependency graph.
  - Shared logic reused from `vi-history-suite` is vendored or published as an
    explicit dependency with a pinned version, not referenced by relative path.
  - The extracted surface is enumerated (a manifest of moved modules) so the
    origin in `vi-history-suite` can be retired or redirected deterministically.
- Change Guidance: Prefer a clean dependency boundary over a fork; record the
  moved-module manifest in the CM plan.

### LBA-REQ-002: Install on Codespace or Vagrant golden VM

- Status: Proposed
- Area: Deployment
- Statement: The extension shall install and activate on **(a)** a GitHub
  Codespace and **(b)** a Vagrant "golden" VM, from the same published artifact.
- Acceptance Criteria:
  - A documented install route produces an activated extension on a Codespace
    with no manual host-specific patching.
  - The same artifact installs on a Vagrant golden VM provisioned from a
    recorded base image, and activation is confirmed by a first-run signal.
  - Host prerequisites (LabVIEW runtime, container runtime, ports) are stated
    per target and checked at activation with actionable remediation.
- Change Guidance: Keep the golden-VM provisioning declarative and versioned so
  the benchmarking baseline is reproducible.

### LBA-REQ-003: Agentic infrastructure drives benchmark runs

- Status: Proposed
- Area: Benchmarking
- Statement: The extension shall expose the agentic infrastructure as the
  driver for **benchmark runs**, producing a time-series of metrics and a
  time-indexed sequence of captured pictures (frames) for each run.
- Acceptance Criteria:
  - A benchmark run emits a schema-versioned result containing (i) an ordered
    metric time-series and (ii) an ordered set of captured pictures, each
    stamped with a monotonic run-relative timestamp.
  - Metric samples and captured pictures share one run clock so any time can be
    resolved to both a metric value and the nearest picture.
  - A run is reproducible: the same inputs and golden VM produce an
    equivalently-shaped result (bounded numeric variance is allowed and
    documented).
  - Captured pictures are recorded into the VM-local **mprr ring buffer**
    (long-packet stream) and indexed via the short-packet stream; the
    run-result frame `ref` points at that local store, never at bytes carried
    over the coordination bus (LBA-REQ-009, ADR-0005).
- Change Guidance: Treat the run-result schema as the contract between the
  actor and the viewer; version it explicitly. Frame payloads are stored via
  mprr, not embedded in the envelope. mprr's short-packet analysis summary
  already yields the ordered timeline (`timingTicks64` + `frameId` +
  `payloadDescriptorId`) this contract needs — confirmed by a headless live
  capture (see `experiments/mprr-live-capture/`).

### LBA-REQ-004: Benchmark time-cursor (draggable vertical line)

- Status: Proposed
- Area: User Interface
- Statement: The benchmark viewer shall render the metric time-series with a
  **draggable vertical cursor** spanning the chart's Y extent; dragging it
  left↔right shall select a point on the time (X) axis.
- Acceptance Criteria:
  - The cursor is draggable with pointer and keyboard (arrow keys step by one
    sample; Home/End jump to run start/end).
  - The selected time is displayed numerically and stays within the run's time
    bounds (no selection outside the recorded window).
  - Dragging is smooth (the cursor tracks input without a full re-render) and
    the selected time updates continuously during the drag.
- Change Guidance: The cursor position is the single source of truth for the
  linked picture panel (LBA-REQ-005); keep them bound to one selected-time
  value.

### LBA-REQ-005: Time-indexed picture shown below the benchmark

- Status: Proposed
- Area: User Interface
- Statement: Directly below the benchmark chart, the viewer shall display the
  **captured picture indexed at the cursor's selected time**, updating as the
  cursor moves.
- Acceptance Criteria:
  - The picture shown is the frame whose timestamp is nearest at-or-before the
    selected time (documented nearest-rule), with its index and timestamp
    labeled.
  - When the cursor moves, the picture updates to the newly-indexed frame
    without desynchronizing from the cursor's selected time.
  - If no picture exists at/near the selected time, the panel shows an explicit
    "no frame at this time" state rather than a stale image.
  - The displayed picture is read from the **VM-local mprr review-capture
    store** (the cleanroom), not fetched over the coordination bus
    (LBA-REQ-009, ADR-0005).
- Change Guidance: Index pictures by run-relative timestamp so cursor→picture
  resolution is O(log n) and deterministic. mprr's short-packet stream already
  supplies this index as `timingTicks64` (100 ns timing authority) keyed to
  `frameId`/`payloadDescriptorId`; a live capture confirmed the resolve path
  end-to-end (see `experiments/mprr-live-capture/`).

### LBA-REQ-006: Multi-VM Vagrant benchmarking topology

- Status: Proposed
- Area: Deployment
- Statement: The system shall support **multiple Vagrant VMs spawned
  concurrently**, each running the extension, participating in one benchmarking
  session.
- Acceptance Criteria:
  - A declarative topology spawns N VMs, each provisioned with the extension
    activated and a unique participant identity.
  - Each VM runs benchmarks independently and stores its results in its **own
    local mprr ring buffer**; VMs do **not** compare runs across each other and
    exchange **no run data** — only inter-actor coordination crosses the bus
    (LBA-REQ-007, LBA-REQ-010).
  - VM teardown is clean and leaves no orphaned bus listeners or lock state.
- Change Guidance: Keep participant identity and topology declarative so a
  session is reproducible and auditable.

### LBA-REQ-007: TCP/UDP coordination bus (replaces GitHub Discussion)

- Status: Proposed
- Area: Coordination Transport
- Statement: Cross-VM coordination shall use a **local TCP and UDP message
  bus** in place of a GitHub Discussion, so benchmarking runs without external
  network or GitHub availability.
- Acceptance Criteria:
  - Reliable, ordered coordination messages (claims, handoffs, results) use
    **TCP**; low-latency presence/liveness and time-sync beacons use **UDP**.
  - Messages are schema-versioned and carry sender identity, timestamp, and a
    session id; a late-joining VM can reconstruct current session state.
  - The bus degrades safely: a lost UDP beacon does not corrupt TCP-ordered
    state, and a dropped TCP peer is detected and surfaced.
  - No coordination path depends on `github.com` or a Discussion at run time.
  - The bus carries **inter-actor communication only** (claim / handoff / ack /
    done / progress / note) — the GitHub-Discussion replacement. It carries
    **no run data, run/frame metadata, or images**; the entire mprr ring buffer
    stays VM-local (LBA-REQ-009, ADR-0005).
- Change Guidance: Mirror the semantics of the GitHub-Discussion collab bus
  (claim / handoff / ack / done, check-before-publish) so the coordination model
  is preserved while the transport changes. `[Assumption]` bind to loopback or
  the private Vagrant network by default; do not expose the bus publicly.

### LBA-REQ-008: Standards-baseline stamp and move-readiness

- Status: Proposed
- Area: Configuration Management
- Statement: This specification package shall carry the `repo-standards-review`
  release it was authored against, and shall be structured to **move** to the
  `labview-benchmark-actor` repository without losing traceability.
- Acceptance Criteria:
  - The package overview and CM plan both name `repo-standards-review`
    **v0.2.19** (commit `d44f210d`).
  - The `docs/` lane layout matches the standards runner's expected structure
    (requirements, architecture, testing, cm, information-for-users, plus the
    information-item map).
  - Requirement IDs are stable across the move (no renumbering on relocation).
- Change Guidance: If the baseline bumps, update the stamp in `README.md` and
  `docs/cm/cm-plan.md` together and re-run the standards validation.

### LBA-REQ-009: VM cleanroom image storage via the mprr ring buffer

- Status: Proposed
- Area: Storage / Capture
- Statement: Captured pictures shall be stored **locally within each VM
  (a cleanroom)** using the existing **mprr** ring buffer, as metadata-indexed
  payload, and shall not be transported over the coordination bus.
- Acceptance Criteria:
  - Pictures are written to the VM-local mprr **long-packet** ring buffer;
    their index/timestamp is written to the **short-packet** stream, per mprr's
    governed dual-packet buffering policy (mprr ADR-0024).
  - The mprr ring buffer (short **and** long packet) stays entirely VM-local;
    **nothing from it is sent over the coordination bus**, which is inter-actor
    communication only (LBA-REQ-007). Runs are not correlated across VMs.
  - The mprr ring buffer model is **owned in-repo** (absorbed dependency-free
    under `experiments/mprr-ring/`, ADR-0009), retaining the frozen
    TDMS-compatible `1.0` replay contract as design lineage; the ring buffer,
    transport, and buffering policy are reused from that self-owned model, not
    re-implemented and not tracked as an external `svelderrainruiz/mprr`
    dependency.
  - `[Confirmed 2026-07-27]` a benchmark frame maps onto exactly one mprr
    long-packet payload: a headless dual-packet live capture (mprr `develop`,
    .NET 8) produced 20/20 frames, each `frameId` bracketed by short-packet
    `frame-start`/`frame-end` and joined to one long-packet payload via
    `payloadDescriptorId`, all `correlationOutcome=authoritative`,
    `driftClass=none` (see `experiments/mprr-live-capture/`).
- Change Guidance: Treat the absorbed mprr model as the authority for the ring
  buffer and replay transport; a schema move requires a successor ADR here
  (ADR-0005, ADR-0009) before this contract can move.

### LBA-REQ-010: Own-run review, host concentration, and the ollama comparison layer

- Status: Proposed
- Area: Analysis
- Statement: Each actor shall review only its **own** previous runs; completed
  runs shall be **concentrated onto the operator's host** out-of-band (not over
  the coordination bus) to feed an **ollama-based comparison layer** that
  compares previous runs.
- Acceptance Criteria:
  - The time-cursor viewer (LBA-REQ-004/005) operates over the **local** actor's
    own run history; there is **no cross-VM run comparison** and no run data on
    the bus.
  - Completed runs are collected from each VM cleanroom to the operator's host
    by an explicit concentration step (e.g. exporting/mounting the VM's mprr
    review-capture store), **never** over the coordination bus.
  - A host-side **ollama** layer compares previous runs (metrics and frames)
    over the concentrated corpus to improve the analysis; it runs on the
    operator's machine, not inside an actor VM.
  - `[Open]` the concentration mechanism and the ollama layer's I/O contract are
    follow-ups (ADR-0006).
- Change Guidance: Keep coordination (bus) and run data (VM-local + host
  concentration) strictly separate; the bus is never a run-data channel.

### LBA-REQ-011: CPU/RAM/disk usage correlation with a pre/post-trigger window

- Status: Proposed
- Area: Analysis / Resource correlation
- Statement: The system shall correlate **CPU, RAM, and disk** usage samples to
  the benchmark **frame timeline** on a shared epoch-ms / frame axis and, anchored
  on a **trigger** instant (e.g. the LabVIEW Getting-Started-Window-visible frame
  or the benchmark-start marker), shall compute a **pre/post-trigger window
  analysis** — count, mean, min, max and the post-minus-pre delta — for each
  metric.
- Acceptance Criteria:
  - Every resource sample resolves to a frame index (floor of elapsed / frame
    interval; null before frame zero, never clamped), matching the frame-index
    rule the picture-cursor viewer uses (LBA-REQ-005).
  - The trigger instant resolves to a `triggerFrameIndex`, and each sample is
    classified `pre` or `post` relative to it, with `sinceTriggerMs` recorded.
  - Per metric (CPU %, RAM MB, disk %) a pre-window and a post-window summary
    (count, mean, min, max) and a `deltaMean = post.mean − pre.mean` are emitted;
    a sample whose counter was absent (null) is skipped in that metric's summary.
  - The core is pure and deterministic (no I/O, no capture dependency) so the
    local gate re-validates it: `[Confirmed 2026-07-28]` the self-test is 9/9
    green over a canonical series with a Getting-Started-Window-visible trigger at
    frame 12 (see `experiments/resource-usage-correlation/`).
- Change Guidance: Sampling (typeperf / logman / Get-Counter) and the live
  Getting-Started-Window capture live in the capture harness (the maintainer / VM
  step); keep this module pure so it stays a re-runnable gate artifact.

---

### LBA-REQ-012: Version-pinned agent base instructions

- Status: Proposed
- Area: Agentic infrastructure (extends LBA-REQ-001, LBA-REQ-003)
- Statement: The system shall embed a canonical agent base-instructions document
  (`AGENTS.md`) in the `lbabus` binary and expose it via `lbabus agents`
  (print / `--out <path>` / `--check <path>`), so that every session using a
  given `lbabus` version shares byte-identical base instructions that can be
  hardened version-over-version.
- Acceptance Criteria:
  - The instructions are embedded in the versioned binary; `lbabus agents`
    prints them with a `sha256`-stamped, version-tagged header.
  - `--out <path>` materializes them to a known file location; `--check <path>`
    exits non-zero when a local copy has drifted from the embedded canonical.
  - The `ci-agents` release-harness stage gates the embed round-trip and the
    drift detection, so every published version's instructions are verified.
- Change Guidance: Iterate the source in `tools/collab-cli/agents/AGENTS.md` and
  cut a new release; do not hand-edit materialized copies.

---

### LBA-REQ-013: Prioritized, addressable coordination messages

- Status: Proposed
- Area: Agentic infrastructure (extends LBA-REQ-007, LBA-REQ-012)
- Statement: The coordination bus shall let a sender tag a message with a
  priority tier and an explicit addressee, and shall let a reader filter its
  inbox by both, so a busy agent can triage which messages to attend to first
  without reading every message. The fields shall be additive and
  backward-read-compatible so an older client parses and ignores them.
- Acceptance Criteria:
  - `lbabus post --priority <P0|P1|P2|P3>` stamps a flat `prio` tier on the
    message (most-urgent first, default `P2`); an absent `prio` reads as `P2`.
  - `lbabus post` stamps the sender's `agentId` (env `VIHS_COLLAB_AGENT_ID`,
    default the plane label); `--to <A>` addresses a plane or an `agentId`.
  - `lbabus poll`/`wait --to-me` keeps only messages addressed to the reader (a
    broadcast, or a `to` matching the reader's plane or `agentId`) and drops
    messages aimed at the other plane.
  - `lbabus poll`/`wait --min-priority <tier>` keeps only messages at least that
    urgent.
  - The additive fields are flat scalars and the wire `schema` is unchanged
    (`vihs-collab-msg@v1`), so a prior-version reader parses the known fields and
    ignores the new ones; a nested-object or schema-bumped envelope is rejected.
- Change Guidance: Keep any future envelope field a flat scalar and keep the
  schema at `vihs-collab-msg@v1`; a nested field or a schema bump silently drops
  the message on already-deployed readers (verified cross-plane, finding 17812593).

### LBA-REQ-014: Cross-plane benchmark comparison

- Status: Proven
- Area: Analysis / storage (extends LBA-REQ-009 storage, LBA-REQ-004 viewer,
  LBA-REQ-010 analysis)
- Statement: The system shall let each plane (LINUX, WIN) produce a
  deterministic benchmark run from the SAME mprr short-packet input, store it on
  a plane-local big drive, and compare the two planes' runs of a shared
  `benchmarkId` -- reporting numeric metric deltas AND content-digest agreement,
  so the next agent can repeat the comparison and get the same verdict.
- Acceptance Criteria:
  - The absorbed mprr short-ring core (`ingestShortPackets`) deterministically
    projects a short-packet stream to a viewer-renderable `[{ t, v }]` series +
    a benchmark summary (blocks, boundary-variation, admission), byte-identical
    for identical input on BOTH planes (the deterministic cross-plane anchor).
  - The shipped viewer renders that series; the deterministic screenshot harness
    captures it twice and asserts BYTE-IDENTICAL per plane (repeatability),
    recording `seriesHash` + `pngSha256`.
  - The benchmark store registers each plane's run (ring-buffer capture BY
    REFERENCE) under a shared `benchmarkId`, and `crossPlaneCompare` reports
    numeric `deltas` + a `digests` section: the deterministic `seriesHash` MUST
    match across planes; the per-plane `pngSha256` is a visual witness; a
    single-plane compare fails closed.
  - The comparison is re-runnable and deterministic (mprr core + projection +
    store are dependency-free): gated by `verify-mprr-ring` (9/9),
    `verify-benchmark-store` (6/6), and local gates #27/#28.
- Change Guidance: Keep the mprr core + projection deterministic and
  dependency-free -- the cross-plane anchor rests on a byte-identical
  `seriesHash`. Treat a cross-OS screenshot pixel difference as an expected
  witness, not a failure. Proven 2026-07-31: a REAL second-plane (WIN) Node run
  (win32/x64, Node v22.15.0, on `actor-win11-decouple` over WinRM) independently
  produced the identical `seriesHash` `7ad1c75d...`, and `crossPlaneCompare`
  confirms the match with all metric deltas 0 (`cross-plane-comparison-receipt.json`,
  gate `cross-plane-comparison-proven-green`). The prior identical-to-LINUX WIN
  `pngSha256` was a synthetic placeholder and has been removed; the per-plane WIN
  screenshot visual witness remains a maintainer step (browser, non-CI).

### LBA-REQ-015: VI Analyzer as a cross-plane benchmark

- Status: Proven
- Area: Analysis / quality (extends LBA-REQ-014; operator VI-Analyzer directive)
- Statement: The system shall install the LabVIEW VI Analyzer Toolkit in the
  Windows clean room and summarize a VI Analyzer run over a repo's VIs into a
  deterministic, ORDER-INDEPENDENT result (per-run pass/fail/error counts + the
  enumerated per-VI findings + a resultHash), so a VI Analyzer run becomes a
  cross-plane-comparable benchmark: two planes summarizing the same run produce
  the same resultHash.
- Acceptance Criteria:
  - The Windows docker clean room installs the VI Analyzer toolkit license
    (`ni-labview-vi-analyzer-toolkit-lic`) from the LabVIEW offline feed,
    enabling `LabVIEWCLI -OperationName RunVIAnalyzer`
    (`cleanroom/docker-windows/install-vi-analyzer.ps1`; Vagrant-reusable).
  - The REAL `LabVIEWCLI RunVIAnalyzer` report (ASCII/HTML) is FAILURE-ORIENTED:
    it emits a run summary of counts and enumerates ONLY the failures + testing
    errors per VI -- passes are never listed. So the normalized report is the
    faithful shape `{ config?, summary: { passed, failed, error, skipped?,
    unloadable? }, findings: [{ viPath, test, result: fail|error }] }`; a clean
    all-pass run (e.g. the icon-editor CI gate) is the summary counts with an
    EMPTY findings array.
  - `summarizeViAnalyzerReport()` normalizes that report to
    `{ totalTests, passedTests, failedTests, errorTests, skippedTests,
    unloadableTests, totalFindings, findingsByVi, pass, resultHash }`; the
    `resultHash` is deterministic, ORDER-INDEPENDENT, and LOCALE-INDEPENDENT
    (code-unit canonical order over the counts + sorted findings), so an
    identical report produces an identical `resultHash` on both planes.
    Consistency teeth: the fail/error findings counts MUST equal the summary
    failed/error counts.
  - A committed JSON Schema (`vi-analyzer-report.schema.json`) + a dependency-free
    validator (`validate-vi-analyzer-report.mjs`, the producing plane's pre-send
    self-check) lock the normalized-report input contract; a reference ASCII->v2
    parser (`parse-vi-analyzer-ascii.mjs`) turns the real CLI report into it.
  - The summary projects to benchmark-store metrics (numeric counts + the
    `resultHash` digest), so `crossPlaneCompare` reports count deltas + the
    `resultHash` agreement (the `resultHash` MUST match cross-plane).
  - The REAL run is proven cross-plane by the CI OS matrix: the committed real
    report (`experiments/vi-analyzer/icon-editor-report.json`, WIN's attested
    all-pass icon-editor run) is pinned by local gate
    `vi-analyzer-real-report-cross-plane-green`, and the LBA Local Gates workflow
    runs on BOTH ubuntu-latest and windows-latest -- so both operating systems
    computing the same `resultHash` for the same real report IS the two-plane
    agreement.
  - The REAL run is ALSO proven cross-plane by two INDEPENDENT LIVE runs (the
    stronger form): the LINUX clean room (64-bit LabVIEW 2026 on Ubuntu/VBox) and
    the WIN clean room (32-bit LabVIEW 2026 on Windows/VBox) EACH ran
    `LabVIEWCLI RunVIAnalyzer` on the same shipped `LabVIEWCLIExampleProject`
    (3 VIs -> 69 tests) as a 6-run determinism trend, and both produced the
    byte-identical `resultHash 0419a449...`
    (`compare-vi-analyzer-trend-cross-plane.mjs` reports `match=true`, exiting 1
    on mismatch). Timing legitimately differs (LINUX cold/warm 2.15x; WIN 19.34x
    -- Windows first-launch mass-compile/indexing), which the store
    `crossPlaneCompare` reports as numeric deltas while the `resultHash` digest
    matches. Receipts: `vi-analyzer-trend-live-evidence.json` (LINUX),
    `vi-analyzer-trend-live-evidence-WIN.json` (WIN), and
    `vi-analyzer-trend-cross-plane-receipt.json`; `verify-vi-analyzer-trend.mjs`
    re-derives every run's hash from committed data (no clean room needed to
    re-check).
  - Gated: `verify-vi-analyzer-result` (7/7), local gates
    `vi-analyzer-result-model-green` + `vi-analyzer-report-schema-green` +
    `vi-analyzer-ascii-parser-green` + `vi-analyzer-real-report-cross-plane-green`.
- Change Guidance: Keep `summarizeViAnalyzerReport` deterministic +
  order-independent + locale-independent (the cross-plane anchor is the
  `resultHash`; sort by code unit, never `localeCompare`). The normalized shape
  mirrors the tool's real failure-oriented output; do NOT reintroduce a
  per-test-pass enumeration the CLI cannot emit. Proven 2026-07-28
  (operator-authorized): WIN ran the real `LabVIEWCLI RunVIAnalyzer` on the
  icon-editor VIs (452 passed / 0 failed, attested on the bus); the all-pass
  report `experiments/vi-analyzer/icon-editor-report.json` (resultHash
  `df9c8d1e...`) is proven cross-plane by the CI OS matrix (see the criterion
  above). WIN's independent re-commit from its Windows machine is welcome as
  corroboration.

### LBA-REQ-016: GitFlow branch governance

- Status: Proven
- Area: Configuration Management (extends LBA-REQ-008; ADR-0010)
- Statement: The repository shall adopt **GitFlow** as its branch-governance
  doctrine — `main` as the protected production branch and `develop` as the
  integration branch, with feature/release/hotfix branch rules — so its
  configuration management passes the authoritative `repo-standards-review` CM
  gate (ISO 10007 §5, ISO/IEC/IEEE 12207) without weakening the CI-owned,
  protected-`main` release-tag publish authority.
- Acceptance Criteria:
  - The CM plan (`docs/cm/cm-plan.md`) states the GitFlow rules: feature
    branches from and back into `develop`; release branches from `develop`,
    merged to `main` and `develop`, then deleted; hotfix branches from `main`,
    merged to `main` and `develop`; SemVer tags on `main`; coverage retained on
    the tagged release path.
  - The decision is recorded in
    `docs/architecture/adr/ADR-0010-gitflow-branch-governance.md`.
  - A `develop` integration branch exists off `main`; features target `develop`
    and `main` advances only through a release (or hotfix) merge, so the
    protected-`main` + CI-owned-tag publish model is unchanged.
  - `repo-standards-review --profile release-gate` reports the `cm` gate PASS
    with no `release-workflow-no-gitflow` contradiction.
- Change Guidance: The CM plan is the canonical governance record; keep the
  GitFlow rules and the SemVer / coverage-on-release lines intact so the CM gate
  stays green. Proven 2026-07-31: the `cm` gate flipped FAIL→PASS under
  `repo-standards-review` v0.2.19 once the governance was recorded (the
  `release-workflow-no-gitflow` contradiction cleared).

---

### LBA-REQ-017: LabVIEW authoring-lane dependency manifest

- Status: Proven
- Area: Authoring lane (Windows/ActiveX build reproducibility)
- Statement: The system shall record every LabVIEW authoring-lane dependency as
  a version-pinned entry in a governed dependency manifest.
- Rationale: The authoring lane (`labview_assistant` + its DQMH dependency + the
  `.vipb` VI-Package build) must build reproducibly on the Windows clean room,
  which requires every dependency pinned to a concrete, verifiable version rather
  than a floating reference.
- Acceptance Criteria:
  - `experiments/labview-authoring/dep-manifest.json` (`dep-manifest@1`) records
    each authoring dependency with a `pinStatus` of `resolved` — carrying a
    concrete git SHA, pip version, or vipc — or `tbd-*` (a pin LINUX still has to
    verify on the VM; allowed to omit its concrete value but not its shape).
  - `verify-dep-manifest.mjs` validates the manifest shape and pin format
    fail-closed: it rejects a bad schema, a malformed SHA, an unknown plane, a
    missing python bitness, a bad `pinStatus`, or a `resolved` entry with an
    empty version.
  - Gated: `verify-dep-manifest.mjs` + `verify-dep-manifest.selftest.mjs` run in
    `verify-local-gates` (an authoring-namespaced check).
- Change Guidance: Keep the manifest single-purpose (pin format + shape only, not
  live resolution) so the check stays deterministic and offline. Authored under
  the `repo-standards-review` singular-requirement directive (one `shall`).

---

### LBA-REQ-018: Provider-delegated cleanroom AI uplift

- Status: Proven
- Area: Distributed CI (AI-provider uplift over the coordination bus; ADR-0011)
- Statement: The system shall delegate a validated uplift task to a
  capability-matched cleanroom AI provider over the coordination bus.
- Rationale: Uplift and documentation-drafting work runs where the licensed
  tooling and capability differentiation live (cleanroom actors running Ollama /
  Copilot CLI / Codex), so the host observes each cleanroom's gated outcome over
  the existing `lbabus` transport rather than hosting providers centrally.
- Acceptance Criteria:
  - `delegateUplift.mjs` validates an `lba-uplift-task@v1` spec, drives a provider
    through the provider-agnostic adapter seam (`providerAdapters.mjs`), applies a
    deterministic acceptance gate (pass and fail), and writes an
    `lba-uplift-delegation-receipt@v1` announced as an ADR-0003 `DONE` frame.
  - The registry/router (`registry.mjs`) dispatches a `CLAIM` only to a live,
    capability-matched worker; the persistent worker pool bounds concurrency; the
    quality pre-gate short-circuits a weak / off-topic / refusal draft.
  - Each uplift domain gates fail-closed: coverage-lift (a proposed test gated on
    the measured line coverage of a target module), evidence (receipt gathering +
    summary accuracy), risky-test (external-tool gate), and VIPM credential +
    capability routing.
  - Gated: the ten `provider-delegation/verify-*.mjs` self-tests run in
    `verify-local-gates`, all deterministic and offline (mock adapter, no GPU /
    no network).
- Change Guidance: Keep the harness provider-agnostic (the adapter seam) and
  composed of existing infra (ADR-0003 bus + `ollama-drive` + `ollama-comparison`);
  do not introduce a new transport. Decision recorded in ADR-0011. Authored under
  the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-019: MCP server agent tool surface

- Status: Proven
- Area: Agentic infra (Model Context Protocol tool surface; ADR-0012)
- Statement: The system shall expose the benchmark actor's tools to a coding
  agent through a Model Context Protocol server.
- Rationale: Coding agents consume tooling through MCP. The actor already holds
  value an agent wants — host capabilities, the deterministic mprr benchmark
  series, and the `lbabus` coordination bus — so a standard MCP surface lets an
  agent discover and call those tools directly rather than through bespoke VS
  Code commands.
- Acceptance Criteria:
  - The pure JSON-RPC 2.0 handler (`benchmarkActorMcpServer.ts`) answers
    `initialize`, `tools/list`, and `tools/call` over newline-delimited stdio,
    publishing exactly four tools — `get_host_capabilities`,
    `get_benchmark_series`, `poll_coordination_bus`, `post_coordination_note` —
    and returns `-32601` / `-32602` for an unknown method / tool.
  - A missing `lbabus` degrades to a soft `isError` tool result, not a transport
    crash, so the agent can act on the message.
  - The definition provider (`benchmarkActorMcpServerProvider.ts`) registers with
    VS Code under the same id the manifest contributes, launching the bundled
    dependency-free stdio entry (`runBenchmarkActorMcpServer.ts`).
  - The bundled tool-doc check keeps `docs/mcp-tools.md` in sync with the
    published registry.
  - Gated: `test/mcp-server.mjs` (pure-core, activation, and stdio legs) and
    `scripts/mcpToolDoc.mjs --check` run under `npm test`, all deterministic and
    host-free (no real VS Code, no display, no live `lbabus`).
- Change Guidance: Keep the protocol logic a pure handler with injected deps and
  the stdio entry dependency-free (Node built-ins only) so no new runtime
  dependency enters the packaged `.vsix`. Decision recorded in ADR-0012. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-020: Bidirectional release sign-off

- Status: Proven
- Area: CM / release governance (bidirectional WIN<->LINUX plane sign-off)
- Statement: The system shall block a component release from publishing until
  both the WIN and LINUX planes have recorded an agreed sign-off for that exact
  component version.
- Rationale: A shared release — the `collab-cli` bus binary (`collab-cli-vX.Y.Z`)
  or the VS Code extension `.vsix` (`ext-vX.Y.Z`) — is co-owned by both planes.
  Letting either plane publish unilaterally would ship an unreviewed change, so
  each component's release workflow fails closed until both planes commit an
  explicit `agreed:true` sign-off for the exact version.
- Acceptance Criteria:
  - `verify-release-agreement.mjs` reads `tools/collab-cli/release-agreement.json`
    (`release-agreement@v2`) and exits 0 only when every required plane (WIN and
    LINUX) records `agreed:true` for the `<component, version>` being published.
  - The gate fails closed: it exits 1 on a missing, withheld (`agreed:false`), or
    unparseable sign-off, and exits 2 on a usage error, so an absent ledger never
    reads as consent.
  - `<version>` accepts the bare SemVer or the tagged form (`collab-cli-vX.Y.Z` /
    `ext-vX.Y.Z`); the default component is `collab-cli` and `--component <name>`
    selects another (e.g. `extension`).
  - Gated in CI: both `.github/workflows/extension-release.yml` and
    `.github/workflows/collab-cli-release.yml` run the gate before their publish
    job, so neither plane can unilaterally ship a shared release.
- Change Guidance: Keep the gate fail-closed and keep both release workflows
  calling it before publish. New required planes extend `requiredPlanes`. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-021: Test-to-requirement correspondence gate

- Status: Proven
- Area: Assurance / traceability (ISO/IEC/IEEE 42010 correspondence graph; ADR-0013)
- Statement: The system shall reject any governed test file that does not
  correspond to at least one requirement in the traceability register.
- Rationale: A test that maps to no requirement is either an untraceable
  capability or dead weight. Enforcing the test-to-requirement correspondence as
  a fail-closed gate keeps the 29119 test suite tied to the 29148 requirements,
  and seeds the 42010 correspondence graph (ADR-0013) whose later rules extend
  the same engine to the decisions and views.
- Acceptance Criteria:
  - `verify-correspondences.mjs` enumerates the governed test set from the
    working tree — `test/*.mjs`, `experiments/**/verify-*.mjs`, `*.selftest.mjs`,
    `*.playwright.{mjs,cjs}`, `playwright/*.mjs`, and `tools/**/verify-*` — and
    exits 1 listing any file absent from every RTM CodeRef (rule TR-1).
  - The engine additionally enforces the ADR-to-requirement (AD-1) and
    requirement-to-view (VW-1) correspondence rules fail-closed: every ADR traces
    to a requirement and is registered in the `overview.md` decision register, and
    every requirement is described by an architecture view (the ADR-0013
    reconciliation).
  - Gated in `verify-local-gates`; deterministic, offline, dependency-free.
- Change Guidance: A new governed test must be added to an RTM CodeRef (or the
  test and its implementation removed) to pass TR-1; a new ADR must trace to a
  requirement and be registered in `overview.md`, and a new requirement must be
  described by a view, to keep AD-1 / VW-1 green (ADR-0013). Authored under the
  `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-022: Generated traceability matrix

- Status: Proven
- Area: Assurance / traceability (ISO/IEC/IEEE 42010 correspondence graph, Stage 3; ADR-0013)
- Statement: The system shall generate the requirement traceability matrix from
  the governed requirement, test, and decision sources.
- Rationale: Hand-maintaining the requirement -> view -> decision -> test -> code
  cross-references invites drift. Deriving a single matrix from the canonical
  sources (the SRS, the RTM, the architecture description, and the ADR register)
  keeps the traceability view honest and current by construction, and makes the
  correspondence graph (ADR-0013) presentable, not only enforceable.
- Acceptance Criteria:
  - `generate-traceability.mjs` reads requirement ids + titles from
    `docs/requirements/srs.md`, status / TestID / CodeRef count from
    `docs/requirements/rtm.csv`, the addressing architecture view from
    `docs/architecture/overview.md` (the `### N.M ... addresses` headings), and
    the decisions from the ADR index `README.md` "Traces to" column, then writes
    `docs/requirements/traceability-matrix.md` (one row per requirement).
  - The generator is deterministic: `--check` re-derives the matrix and exits
    non-zero when the committed file drifts from the sources.
  - Gated: `traceability-matrix-current` runs `--check` in `verify-local-gates`,
    so the derived view cannot rot.
- Change Guidance: Never hand-edit `traceability-matrix.md` -- re-run the
  generator and commit. When a source changes (a requirement, a test mapping, a
  view, or an ADR trace), regenerate. Decision recorded in ADR-0013. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-023: Actor Corroboration Grid (multi-witness release corroboration)

- Status: Planned
- Area: Assurance / release corroboration (ISO/IEC/IEEE 42010; ADR-0014)
- Statement: The system shall gate each governed component release on an on-demand
  corroboration quorum in which a majority of independent witnesses across distinct
  environments agree on the release's deterministic anchors.
- Rationale: A single cleanroom is an unwitnessed single point of trust. Requiring a
  majority of independent, distinct-environment witnesses to agree on the deterministic
  anchors raises release confidence and makes a drifted or forged witness detectable as
  a quorum divergence rather than a silent pass.
- Acceptance Criteria:
  - The Actor Corroboration Grid (ADR-0014) collects a signed receipt bundle from the
    initial three heterogeneous witnesses (Codespace-Linux, VirtualBox-Linux, Windows).
  - OS-independent anchors (viewer `seriesHash`, `lbabus` version + `sourceCommit`,
    gate-suite `verdict`) must agree across all participating witnesses; Linux-only
    anchors (pinned `pngSha256`, Ubuntu codename) across the Linux subset;
    capability / host / timestamps are recorded witnesses.
  - The quorum passes on a >=2-of-3 majority; a sub-majority blocks the release and
    opens a divergence issue.
  - A valid quorum spans distinct environments (N-of-a-kind rejected); each witness
    signs its receipt bundle; consumption verifies the attestation before install.
- Change Guidance: Umbrella requirement for the ACG platform (ADR-0014), delivered
  design-first. A focused sub-requirement family + sub-ADRs (quorum, provenance,
  witness-independence, reviewer station, mesh, MCP) land per phase and flip to Proven
  as each ships. Authored under the `repo-standards-review` singular-requirement
  directive (one `shall`).

### LBA-REQ-024: Corroboration quorum + graded confidence

- Status: Planned
- Area: Assurance / release corroboration (ADR-0015)
- Statement: The system shall pass the release corroboration quorum only when a majority
  of participating witnesses agree on their applicable OS-independent anchors and the
  graded anchor-agreement fraction meets the configured threshold.
- Rationale: A single witness is an unwitnessed point of trust. Grading agreement across a
  majority of heterogeneous witnesses tolerates one outage while still requiring genuine
  cross-environment corroboration.
- Acceptance Criteria:
  - The verdict is the fraction `matched / applicable` anchor dimensions under the tiered
    model (OS-independent anchors across all witnesses; Linux-only across the Linux subset).
  - It passes on a >=2-of-3 majority meeting the threshold.
  - A sub-majority or below-threshold result blocks the release and opens a divergence
    issue naming the dissenting witness and anchor.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0015); flips to Proven when the
  Phase-2 quorum engine ships. Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

### LBA-REQ-025: Corroboration provenance + attestation

- Status: Planned
- Area: Assurance / supply-chain provenance (ADR-0016)
- Statement: The system shall block consumption of a release artifact until its
  corroboration attestation chain verifies.
- Rationale: An unattested or tampered artifact must not be installed on the strength of a
  verdict alone; verifying the signed chain before consumption closes that gap.
- Acceptance Criteria:
  - Each witness signs its receipt bundle (sigstore keyless where an OIDC identity exists,
    an enrolled key otherwise); the verdict, artifacts, and human sign-off are attested.
  - Provenance is stored on the Release, in the repo, in a transparency log, and on the
    mesh ledger.
  - A standalone verify tool and the reviewer-workstation install both verify the chain
    before install.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0016); flips to Proven when the
  Phase-3 signing/verify tooling ships. Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

### LBA-REQ-026: Witness independence

- Status: Planned
- Area: Assurance / anti-forgery (ADR-0017)
- Statement: The system shall reject a corroboration quorum whose witnesses do not span
  distinct enrolled environments.
- Rationale: N identical nodes are not N independent witnesses; requiring distinct enrolled
  environments prevents one actor from forging agreement with look-alike witnesses.
- Acceptance Criteria:
  - A valid quorum spans distinct enrolled environments.
  - A non-enrolled witness, or one that duplicates an already-counted environment, does not
    count toward the majority.
  - Each counted witness's identity is recorded in the provenance.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0017); flips to Proven when the
  Phase-3 enrollment/diversity checks ship. Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

---

## Traceability (requirement → architecture view / test)

| Requirement | Architecture view | Test items |
| --- | --- | --- |
| LBA-REQ-001 | Packaging / boundary | T-001 |
| LBA-REQ-002 | Deployment | T-002 |
| LBA-REQ-003 | Actor / run-result | T-003 |
| LBA-REQ-004 | Viewer (cursor) | T-004 |
| LBA-REQ-005 | Viewer (picture panel) | T-005 |
| LBA-REQ-006 | Multi-VM topology | T-006 |
| LBA-REQ-007 | Coordination transport | T-007 |
| LBA-REQ-008 | CM / move | T-008 |
| LBA-REQ-009 | Storage (mprr ring buffer) | T-009 |
| LBA-REQ-010 | Analysis (concentration + ollama) | T-010 |
| LBA-REQ-011 | Analysis (resource correlation) | T-011 |
| LBA-REQ-012 | Agentic infra (base instructions) | T-012 |
| LBA-REQ-013 | Agentic infra (coordination bus) | T-013 |
| LBA-REQ-014 | Analysis (cross-plane compare) | T-014 |
| LBA-REQ-015 | Analysis (VI Analyzer benchmark) | T-015 |
| LBA-REQ-016 | CM (GitFlow branch governance) | T-016 |
| LBA-REQ-017 | Authoring lane (dependency manifest) | T-017 |
| LBA-REQ-018 | Provider delegation (cleanroom AI uplift) | T-018 |
| LBA-REQ-019 | Agentic infra (MCP tool surface) | T-019 |
| LBA-REQ-020 | CM (bidirectional release sign-off) | T-020 |
| LBA-REQ-021 | Assurance (test-to-requirement correspondence) | T-021 |
| LBA-REQ-022 | Assurance (generated traceability matrix) | T-022 |
| LBA-REQ-023 | Corroboration grid (multi-witness release) | T-023 |
| LBA-REQ-024 | Corroboration grid (quorum + confidence) | T-024 |
| LBA-REQ-025 | Corroboration grid (provenance + attestation) | T-025 |
| LBA-REQ-026 | Corroboration grid (witness independence) | T-026 |
