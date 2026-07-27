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
- Change Guidance: Treat the run-result schema as the contract between the
  actor and the viewer; version it explicitly.

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
- Change Guidance: Index pictures by run-relative timestamp so cursor→picture
  resolution is O(log n) and deterministic.

### LBA-REQ-006: Multi-VM Vagrant benchmarking topology

- Status: Proposed
- Area: Deployment
- Statement: The system shall support **multiple Vagrant VMs spawned
  concurrently**, each running the extension, participating in one benchmarking
  session.
- Acceptance Criteria:
  - A declarative topology spawns N VMs, each provisioned with the extension
    activated and a unique participant identity.
  - Each VM can run benchmarks independently and publish its results to the
    shared session.
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
