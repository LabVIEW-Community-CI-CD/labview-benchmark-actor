# LabVIEW Benchmark Actor

> **Reproducible, cross-plane LabVIEW benchmarking — coordinated by an actor mesh, driven by agents, with no central data hoarding.**

A free, open-source VS Code extension for the LabVIEW CI/CD community. It turns a personal, sandbox-isolated "golden" VM (Ubuntu 24.04 + LabVIEW 2026 Community Edition + VIPM) into a **benchmark actor** that runs headless LabVIEW benchmarks, coordinates on-demand distributed runs with other actors, and produces portable, fail-closed **receipts** you own — so results can be objectively compared across operating systems, hardware, and LabVIEW versions.

Everything is **governed by construction**: every capability is proven on real data with a committed receipt and a fail-closed gate (180+ gates on `develop`), and the requirements ⇄ tests ⇄ architecture decisions stay in a checked correspondence graph (ISO/IEC/IEEE 29148 / 42010 / 29119).

## What it does

- **Benchmark time-cursor viewer** — a metric chart with a draggable vertical time cursor; drag it and the captured frame indexed at that instant is shown below, keeping the metric and the visual evidence synchronized. Capture is frame-locked at **exactly 12 FPS** — the shared clock across every plane.
- **The actor mesh** — register your golden VM as an actor; a requester dispatches a cross-plane benchmark run **GitHub-natively** (`repository_dispatch` / Actions as the queue — zero central infrastructure), and volunteer actors return plane-tagged receipts. A run is *fulfilled* only when enough independent cross-plane actors returned a valid receipt for the same benchmark identity. **No central results database — the receipts are the result.**
- **Verify-before-consume trust** — an opt-in verified tier signs each actor receipt with an enrolled key, records it in an RFC-6962 transparency log, and proves the log is append-only. A single **fully-attested** verdict tells a consumer a run is trustworthy end-to-end (identity + signature + transparency inclusion + append-only).
- **Cross-plane comparison at scale** — reproducible parity + comparison receipts across the OS and hardware axes, with the mesh-stress calibration **discounting** results captured on a contended actor so comparisons stay fair.
- **Coordination bus (`lbabus`)** — actors on a LAN coordinate over a local TCP + UDP message bus; the bus carries inter-actor messages only — run data never crosses it.
- **MCP tools for agent mode** — the extension contributes a dependency-free Model Context Protocol server so Copilot agent mode can call its tools directly (host capabilities, the deterministic benchmark series, the coordination bus).

## Install

Install **LabVIEW Benchmark Actor** from the VS Code Marketplace (publisher `labview-community-ci-cd`), or from a packaged `.vsix`. Requires VS Code **1.101+**. The extension is fully free and non-commercial; running LabVIEW benchmarks happens locally in your own activated golden VM.

## Quickstart

1. **Provision a personal golden VM** — one command mints a clean Ubuntu 24.04 VM, installs LabVIEW 2026 Community Edition + VIPM from NI's apt repo, and hands off to you for the one irreducibly-human step: signing in to your NI account and **activating** LabVIEW CE. The tool then confirms activation with a headless probe VI and mints your local golden VM.
2. **Register it as an actor** — the activated VM is registered in your local actor registry; it stays local to you (no boxes are published to a shared registry).
3. **Join the mesh** — follow the [join-the-mesh quickstart](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/join-the-mesh.md) to answer a dispatched run and return your first plane-tagged receipt.

Full walkthroughs: the [getting-started guide](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/getting-started.md), the [user guide](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/user-guide.md), and the [command reference](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/command-reference.md).

## Principles

- **Reproducibility over telemetry** — the mesh coordinates *runs*, not a central results database; evidence is a portable receipt owned by whoever produced it.
- **Real data, no fakes** — every capability is proven on a real capture with a committed receipt and a fail-closed gate.
- **Sandbox = the golden VM** — distributed runs execute inside your isolated VM; provenance/attestation is an opt-in stronger tier, not a gate on participation.
- **Hybrid labor** — agents drive the automation; a human does the irreducibly-human steps (the NI-account activation, hardware, physical provisioning).
- **Free + non-commercial** — LabVIEW Community Edition is the substrate; the extension ships free.

## How it's governed

The project is developed as fail-closed, receipt-backed increments. Requirements, tests, architecture decisions, and the executable gate suite stay in a checked correspondence:

| Standard | Lane | Artifact |
| --- | --- | --- |
| ISO/IEC/IEEE 29148 | Requirements | [software requirements specification](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/requirements/srs.md) |
| ISO/IEC/IEEE 42010 | Architecture | [architecture overview + ADRs](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/overview.md) |
| ISO/IEC/IEEE 29119 | Test | [test plan](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/testing/test-plan.md) |
| ISO 10007 / 12207 | Configuration & release | [CM plan](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/cm/cm-plan.md) |
| ISO/IEC/IEEE 26514 | Information for users | [user guide](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/information-for-users/user-guide.md) |

The multi-year vision and near-term slice live in the [roadmap](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/roadmap.md).

**Absorbed model:** the bounded-RAM `mprr` ring-buffer model (dual-packet policy + a frozen replay transport) is absorbed in-repo as dependency-free mirrors — the project owns it and tracks no external repository ([ADR-0009](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/docs/architecture/adr/ADR-0009-absorb-mprr-model-self-owned.md)).

**Standards baseline:** authored against `repo-standards-review` **v0.2.19** (commit `d44f210d`).

## Contributing & support

- **Issues:** [github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/issues](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/issues)
- **Changelog:** [CHANGELOG.md](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/CHANGELOG.md)
- **License:** see [LICENSE](https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/blob/main/LICENSE)

*Community, non-commercial project. Not affiliated with or endorsed by National Instruments; "LabVIEW" is a trademark of its respective owner.*
