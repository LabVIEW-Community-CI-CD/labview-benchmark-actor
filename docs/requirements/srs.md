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

**External canonical dependency:** captured pictures are stored via **mprr**
(`svelderrainruiz/mprr`, `develop`) — its bounded-RAM dual-packet ring buffer
(mprr ADR-0024) and frozen TDMS-compatible `1.0` replay transport — inside each
VM cleanroom. labview-benchmark-actor consumes mprr; it does not re-implement
the ring buffer (see LBA-REQ-009, ADR-0005).

The coordination bus carries **inter-actor communication only** (the
GitHub-Discussion replacement); run data never crosses it. Agents do not compare
runs across VMs — each reviews its own previous runs, and the operator
concentrates runs onto the host for an ollama comparison layer (LBA-REQ-010,
ADR-0006).

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
  - mprr is consumed as an external canonical dependency
    (`svelderrainruiz/mprr`, frozen TDMS-compatible `1.0` replay contract),
    version-pinned; the ring buffer, transport, and buffering policy are reused,
    not re-implemented.
  - `[Confirmed 2026-07-27]` a benchmark frame maps onto exactly one mprr
    long-packet payload: a headless dual-packet live capture (mprr `develop`,
    .NET 8) produced 20/20 frames, each `frameId` bracketed by short-packet
    `frame-start`/`frame-end` and joined to one long-packet payload via
    `payloadDescriptorId`, all `correlationOutcome=authoritative`,
    `driftClass=none` (see `experiments/mprr-live-capture/`).
- Change Guidance: Treat mprr as the authority for the ring buffer and replay
  transport; an mprr schema move requires a successor ADR here (ADR-0005) before
  this contract can move.

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
