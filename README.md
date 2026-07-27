# labview-benchmark-actor — Specification Package

> **Status:** Prototype specification (planning). No implementation yet.
> **Standards baseline:** `repo-standards-review` **v0.2.19** (GitLab
> `svelderrainruiz/repo-standards-review`, commit `d44f210d`).
> **Stamp rationale:** this package is authored to move to a future
> `labview-benchmark-actor` repository; the standards-release stamp travels
> with it so the receiving repo can re-validate against the exact baseline it
> was written to.

## Purpose

`labview-benchmark-actor` extracts the **hooking and agentic infrastructure**
currently developed on `vi-history-suite`'s `develop` and `prototype` branches
into a **standalone, installable VS Code extension**. Installed on a **GitHub
Codespace** or a **Vagrant golden VM**, it lets an operator drive
**benchmarking** through that agentic infrastructure and review results through
a **time-cursor benchmark viewer**.

Three capabilities distinguish it from the parent repo:

1. **Benchmark time-cursor UI** — a benchmark chart with a draggable **vertical
   time cursor**; dragging it left↔right selects a point in time, and the
   **captured picture (frame) indexed at that time** is shown directly below the
   chart, keeping metric and visual evidence synchronized.
2. **TCP/UDP coordination bus** — multiple Vagrant VMs, each running the
   extension, coordinate over a **local TCP + UDP message bus** instead of a
   GitHub Discussion, so benchmarking runs offline / air-gapped and in parallel
   across VMs. The bus carries **coordination + index metadata only**.
3. **VM cleanroom image storage** — captured pictures are stored **locally in
   each VM** via the existing **mprr** ring buffer (`svelderrainruiz/mprr`,
   `develop`) as metadata-indexed payload; **image bytes never travel the bus**
   (LBA-REQ-009, [ADR-0005](docs/architecture/adr/ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md)).

## External dependency

- **mprr** (`svelderrainruiz/mprr`, `develop`) — the canonical authority for the
  bounded-RAM dual-packet **ring buffer** (mprr ADR-0024) and the frozen
  TDMS-compatible `1.0` replay transport. This package **consumes** mprr for
  VM-local image storage; it does not re-implement the ring buffer. Pin the mprr
  version; an mprr schema move requires a successor ADR here.

## Standards coverage

| Standard | Lane | Package artifact |
| --- | --- | --- |
| ISO/IEC/IEEE 29148 | Requirements | [docs/requirements/srs.md](docs/requirements/srs.md) |
| ISO/IEC/IEEE 42010 | Architecture description | [docs/architecture/overview.md](docs/architecture/overview.md) |
| ISO/IEC/IEEE 29119-2/3 | Test | [docs/testing/test-plan.md](docs/testing/test-plan.md) |
| ISO 10007 / ISO/IEC/IEEE 12207 | Configuration management & release | [docs/cm/cm-plan.md](docs/cm/cm-plan.md) |
| ISO/IEC/IEEE 26514:2022 | Information for users | [docs/information-for-users/user-guide.md](docs/information-for-users/user-guide.md) |
| ISO/IEC/IEEE 15289 | Information item map | [docs/information-item-map.md](docs/information-item-map.md) |

Cite standards as `Std §clause` throughout; keep observations separate from
assumptions; show repo-relative evidence for load-bearing claims.

## Requirement ID scheme

Software requirements use `LBA-REQ-NNN`; acceptance criteria are cited by
position as `LBA-REQ-NNN.M` (matching the parent repo's derived-position
convention).

## Move / graduation note

When this package graduates to the `labview-benchmark-actor` repository:

- Re-run `python3 scripts/pipeline.py validate-skill` against
  `repo-standards-review` **v0.2.19** (or bump this stamp and re-validate).
- Preserve the `docs/` layout so the standards runner resolves each lane.
- Carry the requirement IDs unchanged so external traceability survives the move.
