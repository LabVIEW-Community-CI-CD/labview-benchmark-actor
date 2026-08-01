# labview-benchmark-actor — Specification Package

> **Status:** Originating specification. The extension is now implemented and ships as `ext-v*` GitHub Releases (latest `ext-v0.4.0`).
> **Standards baseline:** `repo-standards-review` **v0.2.19** (GitLab
> `svelderrainruiz/repo-standards-review`, commit `d44f210d`).
> **Stamp rationale:** this package is authored to move to a future
> `labview-benchmark-actor` repository; the standards-release stamp travels
> with it so the receiving repo can re-validate against the exact baseline it
> was written to.

## Purpose

`labview-benchmark-actor` is a **standalone, installable VS Code extension**
providing **hooking and agentic benchmarking infrastructure** (originally
prototyped in `vi-history-suite`, since extracted into this independent repo —
no runtime dependency on that prototype). Installed on a **GitHub
Codespace** or a **Vagrant golden VM**, it lets an operator drive
**benchmarking** through that agentic infrastructure and review results through
a **time-cursor benchmark viewer**.

Five capabilities define the extension:

1. **Benchmark time-cursor UI** — a benchmark chart with a draggable **vertical
   time cursor**; dragging it left↔right selects a point in time, and the
   **captured picture (frame) indexed at that time** is shown directly below the
   chart, keeping metric and visual evidence synchronized.
2. **TCP/UDP coordination bus** — multiple Vagrant VMs, each running the
   extension, coordinate over a **local TCP + UDP message bus** instead of a
   GitHub Discussion, so benchmarking runs offline / air-gapped and in parallel
   across VMs. The bus carries **inter-actor communication only** — no run data
   ever crosses it.
3. **VM cleanroom storage** — a run's data (metrics **and** pictures) is stored
   **locally in each VM** via the **mprr** ring buffer model
   (absorbed in-repo, dependency-free — see
   [ADR-0009](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/adr/ADR-0009-absorb-mprr-model-self-owned.md));
   **no run data crosses the bus** — the
   whole ring buffer is VM-local (LBA-REQ-009,
   [ADR-0005](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/adr/ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md)).
4. **Own-run review + host ollama comparison** — each actor reviews only its
   **own** previous runs; there is **no cross-VM comparison**. The operator
   concentrates runs onto the host (out-of-band) to improve an **ollama**
   comparison layer over previous runs (LBA-REQ-010,
   [ADR-0006](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/adr/ADR-0006-run-concentration-ollama-comparison.md)).
5. **MCP tools for agent mode** — the extension contributes a **Model Context
   Protocol** server (a dependency-free stdio JSON-RPC server) so Copilot agent
   mode can call the extension's own tools directly: host capabilities, the
   deterministic benchmark series, and the coordination bus (poll / post).

## Absorbed model

- **mprr** — the bounded-RAM dual-packet **ring buffer** model (dual-packet policy
  from mprr ADR-0024) and the frozen TDMS-compatible `1.0` replay transport, **absorbed
  in-repo as dependency-free mirrors** under `experiments/mprr-ring/` and exercised by
  `experiments/verify-local-gates.mjs`. The `mprr` name is retained for the local model;
  labview-benchmark-actor owns it and does not track an external repository
  ([ADR-0009](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/adr/ADR-0009-absorb-mprr-model-self-owned.md)).

## Standards coverage

| Standard | Lane | Package artifact |
| --- | --- | --- |
| ISO/IEC/IEEE 29148 | Requirements | [docs/requirements/srs.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/requirements/srs.md) |
| ISO/IEC/IEEE 42010 | Architecture description | [docs/architecture/overview.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/overview.md) |
| ISO/IEC/IEEE 29119-2/3 | Test | [docs/testing/test-plan.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/testing/test-plan.md) |
| ISO 10007 / ISO/IEC/IEEE 12207 | Configuration management & release | [docs/cm/cm-plan.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/cm/cm-plan.md) |
| ISO/IEC/IEEE 26514:2022 | Information for users | [docs/information-for-users/user-guide.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/user-guide.md) |
| ISO/IEC/IEEE 15289 | Information item map | [docs/information-item-map.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-item-map.md) |

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
