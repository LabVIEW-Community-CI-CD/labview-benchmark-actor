# Changelog

All notable changes to the **LabVIEW Benchmark Actor** extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Flip the coordination default to `net` + graceful no-op — off GitHub Discussions, step 6** (ADR-0045,
  LBA-REQ-065). `labviewBenchmarkActor.busTransport` now defaults to the live-only `lbabus net` TCP bus across
  the extension, the MCP tools, and `post-verdict.mjs`; GitHub Discussion becomes a legacy opt-out
  (`busTransport: "discussion"` / `VIHS_COLLAB_TRANSPORT=discussion`). An unconfigured net-default install is a
  silent no-op — `net poll` with no receive-log and `net send --skip-if-no-peer` with no peer both exit 0 with a
  hint (the poll fail-closed of ADR-0040 is softened to graceful; no dead loopback). Gated by
  `net-default-graceful` + `bus-transport-select` (default is `net`).
- **Drop the release-CI GitHub-Discussion announce — off GitHub Discussions, step 5** (ADR-0044, LBA-REQ-064).
  The release publish workflow no longer announces the reviewer verdict to a GitHub Discussion (the `Set up
  .NET` + announce steps are removed) — the durable record of the human PASS is the committed signed verdict
  (release-agreement `visualReview`, keyless counter-signed), and off-CI a reviewer announces over `net` via
  `post-verdict.mjs` / the extension. Removes the last GitHub-Discussion dependency from the publish pipeline.
  Gated by `release-no-discussion-announce`.
- **Verdict announcer transport selection — off GitHub Discussions, step 4** (ADR-0043, LBA-REQ-063).
  `reviewer-workstation/post-verdict.mjs` now honors the same switch: under `VIHS_COLLAB_TRANSPORT=net` (+
  `VIHS_COLLAB_NET_HOSTS`) it announces a signed verdict via `net send` with the same semantic type, else the
  Discussion `post` (default). `--print-args` honors it, so the release workflow is unchanged at the default.
  Gated by `post-verdict-net-transport`.
- **MCP tools bus transport selection — off GitHub Discussions, step 3** (ADR-0042, LBA-REQ-062). The
  extension's MCP server now honors the same transport switch: the provider passes `busTransport` / `busNetHosts`
  / `busNetLog` to the stdio server as env, and `poll_coordination_bus` → `net poll` / `post_coordination_note`
  → `net send` under `net` (Discussion default). The agent tool surface coordinates over TCP when configured;
  tool schemas unchanged. Gated by `mcp-net-transport`.
- **Extension bus transport selection — off GitHub Discussions, step 2** (ADR-0041, LBA-REQ-061). The
  extension can now coordinate over the live-only `lbabus net` TCP bus instead of a GitHub Discussion: a new
  `labviewBenchmarkActor.busTransport` setting (`discussion` default | `net`) plus `busNetHosts` / `busNetLog`
  route **Post Note** → `net send`, **Poll Bus** → `net poll` (the local receive-log), and the reviewer-verdict
  announcement → `net send --message-file` (reusing the semantic `RESOLVED`/`REFINE`/`BLOCKED` types). The
  Discussion transport stays the **default** (no user-facing change; opt in per actor). Gated by
  `bus-transport-select`.
- **Live-only `net` coordination — off GitHub Discussions, step 1** (ADR-0040, LBA-REQ-060). The
  coordination read side now rides TCP: `lbabus net listen --log <file>` records received frames to a
  per-actor JSONL **receive-log**, and new **`lbabus net poll`** reads + filters it (by `--type` / `--task`),
  mirroring the Discussion `poll` over the private bus (the send side is the existing `net send`). Live-only
  by design — no central/async store, so an offline peer misses a post; durable records are the committed
  artifacts, not a bus log. Gated by `net-coordination-log`. First increment of retiring the GitHub-Discussion
  transport.
- **Host↔VM-agent closed loop over TCP** (ADR-0039, LBA-REQ-059). The host now drives the reviewer
  VM's Copilot agent and **awaits its reply over the `lbabus net` TCP bus** — `await-agent-reply.mjs`
  runs `lbabus net listen` and correlates the VM agent's reply frame by task id (fail-closed on
  mismatch/timeout); `drive-agent-closed-loop.sh` composes the keyboard-inject with the await. The
  `net` envelope type set gains the semantic verdict statuses **`RESOLVED`/`REFINE`/`BLOCKED`**, so a
  signed reviewer verdict announces over TCP as a first-class semantic event — the first concrete step
  of moving coordination **off GitHub Discussions**. Gated by `closed-loop-readback`. Proven live: three
  drives from the reviewer VM (`senderId=WIN`) — the loop, a real benchmark review (2604 ms / 5 samples →
  PASS via the extension tool), and the signed verdict announced as `RESOLVED`.
- **Handoff Beacon — reviewer verdict bus announcement** (ADR-0038, LBA-REQ-058).
  A signed reviewer verdict is now announced on the `lbabus` coordination bus with
  a **semantic** message type — **pass → RESOLVED**, **changes → REFINE**,
  **fail → BLOCKED** — carrying the full signed verdict JSON, so the WIN plane and
  remote actors see the human's PASS/FAIL as an actionable coordination event. The
  extension posts it from the reviewer VM right after signing (best-effort), and the
  release CI posts it automatically after the visual-review gate passes. This
  completes the Handoff Beacon Protocol's five governed tiers.
- **Handoff Beacon — reviewer visual verdict** (`reviewer-verdict@1`, ADR-0037,
  LBA-REQ-057). The human's VISUAL PASS / CHANGES / FAIL of an extension release
  candidate is now a signed, governed artifact. The new **Render Reviewer Verdict**
  command records the verdict (bound to the candidate's version + commit + `.vsix`
  digest, with capture-evidence pointers) and **Ed25519-signs it in the VM** with an
  enrolled reviewer key (no OIDC), mapping to an `acg-human-signoff-v1`. A fail-closed
  gate (`verify-visual-review`) requires a passing, signed verdict from an enrolled
  reviewer to publish a release — composed with the machine release gate and the
  WIN↔LINUX plane agreement; CI keyless-cosign counter-signs the verdict bundle.
  Reviewer keys are minted with `reviewer-workstation/enroll-reviewer.mjs`.
- **Handoff Beacon — agent→human request** (`agent-request@1` / `op-done@1`,
  ADR-0036, LBA-REQ-056). The agent can now ask the human to perform a manual
  step in the reviewer VM; the ask surfaces as a VS Code notification with
  **Mark step done** / **Skip** actions (also the `Mark Handoff Step Done` /
  `Skip Handoff Step` palette commands), and the answer is written as a
  machine-readable `op-done` beacon the agent awaits — a reusable human-step
  barrier, the other direction of the capture-status beacon. A committed host
  wrapper (`reviewer-workstation/request-step.sh`) drops the request into the VM
  and polls the answer once.
- **Frame Correlator auto-jump to the peak-write frame** (ADR-0035, LBA-REQ-055).
  On Stop, the correlator now opens on the capture-status beacon's peak-write
  frame (clamped into range) instead of frame 0, so the human and the agent land
  straight on the disk-throughput evidence. Reopening a completed capture reads
  the same beacon and jumps there too.
- **Handoff Beacon — capture-status** (`capture-status@1`, ADR-0035). The extension
  now writes a machine-readable `capture-status.json` beacon into each capture's
  run dir at start (`capturing`) and stop (`stopped` with a rich payload —
  `wroteToDisk`, the peak write MB/s + the frame index where it peaked, and a
  per-physical-disk write/read peak breakdown — or `failed` on assembly error).
  A committed host poller (`reviewer-workstation/await-handoff.sh`) awaits the
  human's Stop and returns the payload, so the agentic flow leverages human
  assistance efficiently instead of guessing or re-asking.
- **Per-physical-disk read/write throughput (MB/s)** in the live LabVIEW-launch
  capture and Frame Correlator. The launch sampler now records `Disk Write
  Bytes/sec` and `Disk Read Bytes/sec` for **every physical disk** and the
  correlator plots a write and a read curve per disk alongside CPU / RAM /
  % Disk Time. A real disk workload (e.g. a streaming VI at ~11 MB/s) now shows
  on the throughput curve even though `% Disk Time` — a *busy-time* metric —
  barely moves for that load.

### Changed
- The launch-capture resource sampler switched from the slow per-iteration CIM
  loop (~0.8 s/sample) to fast `System.Diagnostics.PerformanceCounter`
  `NextValue()` reads (sub-millisecond) frame-locked to ~100 ms, so short bursts
  register. `% Disk Time` is retained (now via the same counter path).

## [0.5.0] - 2026-08-02

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

### Fixed
- **MCP grid tools now declare `items` on every array parameter** — the bundled
  MCP server's `run_quorum` / `get_confidence` / `verify_attestation` /
  `check_independence` tools declared their `bundles` / `witnesses` array inputs
  without the JSON-Schema `items` subschema, which the VS Code tool validator
  rejects ("tool parameters array type must have items"), breaking agent-mode use
  of *all* the extension's tools. A pure-schema regression guard
  (`experiments/acg-mcp/grid-tools.selftest.mjs`, gate `acg-mcp`) now fails closed
  on any malformed published tool schema so it cannot ship again.

### Docs
- **Roadmap** (`docs/roadmap.md`) and **ADR-0023** — the multi-year vision and the
  near-term personal-golden-VM onboarding slice (`LBA-REQ-033`).
- Formalized the **mesh-stress performance-signature calibration** requirement
  (`LBA-REQ-032`), proven four ways on real data: a host sequential ladder, a
  host concurrent 5-actor mesh, a real Windows VM actor, and two simultaneous
  real Windows VMs.
- Decoupled the reviewer / authoring documentation from the `vi-history-suite`
  prototype.
- Added a reviewer **agent-chat smoke test** (TC-11) plus an authoritative host-side
  driver (`reviewer-workstation/drive-agent-chat.sh`) that drives the reviewer VM's
  agent chat and captures screenshot evidence — the procedure that caught the MCP
  schema defect above.

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
