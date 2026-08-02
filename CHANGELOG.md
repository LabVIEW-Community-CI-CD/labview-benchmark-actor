# Changelog

All notable changes to the **LabVIEW Benchmark Actor** extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Mesh-Stress Calibration** and **Concurrent Mesh Board** commands — two
  strict-CSP, script-free webview analysis views. The calibration view renders a
  stress-ladder *curve* (each rung's expected performance-counter band, the
  monotone / separable / repeatable invariants, and an inverse-read of an
  observed signature to its stress level); the board renders a live *snapshot* of
  N simultaneously-stressed actors, each tile showing its measured stress and the
  rung the calibration inferred. Both are also openable by an agent through the
  `lba-open-benchmark-panel` language-model tool (`panel=meshCalibration` /
  `panel=meshBoard`).
- **Exact-12-FPS performance-counter correlation** — a cross-platform sampler
  pair (Linux `/proc`, Windows PDH) captures the v2 performance-counter catalog
  frame-locked to the 12-FPS benchmark clock; the frame correlator plots the
  counter curves and supports click-to-marker annotations persisted into the
  capture metadata.

### Changed
- The frame correlator now renders the full v2 performance-counter catalog, with
  a backward-compatible fall back to the legacy CPU / RAM / disk fields.
- The reviewer-workstation tool install is resilient to broken `winget` sources
  (best-effort winget, then a direct-download fall back).

### Docs
- **Roadmap** (`docs/roadmap.md`) and **ADR-0023** — the multi-year vision and the
  near-term personal-golden-VM onboarding slice (`LBA-REQ-033`).
- Formalized the **mesh-stress performance-signature calibration** requirement
  (`LBA-REQ-032`), proven four ways on real data: a host sequential ladder, a
  host concurrent 5-actor mesh, a real Windows VM actor, and two simultaneous
  real Windows VMs.
- Decoupled the reviewer / authoring documentation from the `vi-history-suite`
  prototype.

## [0.4.0] - 2026-08-01

### Added
- **Run Corroboration Grid** and **Verify Release Provenance** commands — run the
  Actor Corroboration Grid end-to-end and the verify-before-install provenance check
  from the Command Palette.
- The bundled **MCP server now folds in the corroboration-grid tools** — its `tools/list`
  publishes 13 tools (the 4 core plus `run_quorum`, `get_confidence`, `verify_attestation`,
  `check_independence`, `assemble_witness`, `verify_inclusion`, `verify_before_install`,
  `spin_up_witness`, `teardown`) from the single shipped extension server, so an agent can
  orchestrate release corroboration directly.

### Security
- The release `.vsix` is keyless-signed with cosign / sigstore (a Fulcio certificate + a
  public rekor entry) at release creation, and the reviewer-workstation verifies that
  signature before installing.

## [0.3.0] - 2026-07-31

### Added
- **Benchmark evidence panels** — six new webview commands render the extension's REAL captured LabVIEW
  IDE-launch benchmark evidence in strict-CSP, nonce-scoped webviews (no network, no eval):
  - **Open Benchmark Run** — a single launch record: the `launchMs` headline, the UI-READY settle frame
    rendered as an 8×8 dhash (perceptual-fingerprint) grid, and the capture stats.
  - **Open Benchmark Trend** — `launchMs` across N runs with a median baseline, a least-squares drift
    slope, and a PASS / REGRESSION verdict.
  - **Open Benchmark Frame Correlator** — a grab-and-drag red vertical line scrubs one launch's frames over
    time: the CPU / RAM / disk curves (upper graph) and the REAL captured screenshot at that exact frame
    (lower pane) track the cursor.
  - **Open Cross-Plane Benchmark Trend** — the two hypervisor planes' `launchMs` trends overlaid, with the
    witnessed cross-plane delta.
  - **Open Benchmark Resource Profile** — CPU / RAM / disk sampled live during the launch and correlated
    to the frame timeline, split at the UI-READY trigger (pre = launching → post = settled).
  - **Open Cross-Plane Resource Agreement** — the two planes' resource deltas with per-metric agreement.
- **Get Started walkthrough** — a guided *"Get started with LabVIEW Benchmark Actor"* walkthrough (opens on
  install) that steps through the panels so the extension is self-explanatory.
- **Copilot agent tools** — two language-model tools let a Copilot **agent** drive the extension from a
  prompt: `lba-open-benchmark-panel` (open any panel) and `lba-benchmark-summary` (summarize the captured
  numbers). Reference them in a prompt as `#lbaBenchmarkPanel` / `#lbaBenchmarkSummary`.
- **Capture LabVIEW Launch** — a one-click command records a real LabVIEW launch inside the Windows VM at
  12 fps (ffmpeg `gdigrab`) while sampling CPU / RAM / disk, then opens the frame correlator on it. Frames
  and metrics are captured and stored VM-locally (nothing is embedded in the `.vsix`); a status-bar
  **Stop LabVIEW Capture** ends it. Configurable via `labviewBenchmarkActor.ffmpegPath` /
  `labviewBenchmarkActor.labviewPath`.

### Notes
- First release to also carry the 0.2.0 additions (the dependency-free MCP stdio server + Marketplace
  listing polish); ext-v0.2.0 was agreement-cleared but never tagged, so 0.3.0 supersedes it.

## [0.2.0] - 2026-07-30

### Added
- MCP tools: the extension contributes a **Model Context Protocol** server (a dependency-free stdio
  JSON-RPC server) exposing its own tools to Copilot agent mode — `get_host_capabilities`,
  `get_benchmark_series`, `poll_coordination_bus`, and `post_coordination_note`.
- Marketplace listing polish: extension icon, gallery banner, keywords, and `Visualization` / `Testing`
  categories.
- Marketplace publish: the `extension-release` workflow now publishes the built `.vsix` to the VS Code
  Marketplace (fork-safe, PAT-gated, fail-open) after the bidirectional WIN&harr;LINUX agreement gate, and
  guards the `.vsix` size so a non-runtime leak can never be released or published.

## [0.1.1]

### Added
- **Benchmark viewer** (`LabVIEW Benchmark Actor: Open Benchmark Viewer`) — renders the deterministic
  mprr ring-buffer metric series with a draggable time cursor, in a strict-CSP nonce-scoped webview.
- **Host capabilities** (`Show Host Capabilities`) and the **coordination bus** (`Poll Coordination Bus`,
  `Post Coordination Note`), backed by the `lbabus` CLI.
- **Extension-embedded agent instructions** — `Write` / `Show` / `Check Agent Instructions` materialize and
  drift-check a version-pinned `AGENTS.md` (sha256 over the canonical body).
- Prerequisite remediation surfaced when the `lbabus` coordination CLI is not installed.

### Notes
- The extension depends only on `vscode` + Node built-ins — no `vi-history-suite`-private module on its
  graph (LBA-REQ-001).
