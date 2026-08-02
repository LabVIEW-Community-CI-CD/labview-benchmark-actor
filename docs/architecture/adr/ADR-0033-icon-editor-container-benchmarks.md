# ADR-0033: Icon-editor CI benchmarks in the NI LabVIEW container (2-actor grid — build + test)

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "make a grid of 2 actors that one builds the ppl and the other tests over lunit; research how the icon editor does it on linux") + agent
- Relates to: LBA-REQ-051, ADR-0031 (cross-plane comparison / benchmark grid), docs/roadmap.md (Phase 2 — the real benchmark suite), ni/labview-icon-editor CI

## Context

The cross-plane benchmark grid (ADR-0031, LBA-REQ-050) compares LabVIEW benchmarks
across planes. `ni/labview-icon-editor` is a real, public LabVIEW project with a real
CI whose Linux path runs **inside the `nationalinstruments/labview:2026q1-linux`
Docker image** and drives everything through **g-cli**:

- **build** the "Editor Packed Library" build spec → a Packed Project Library (`.lvlibp`)
  (`.github/actions/build-lvlibp`, `g-cli … lvbuildspec`), and
- **test** the LUnit unit-test suite (`.github/actions/run-unit-tests`, `g-cli … lunit`).

Reproducing that real CI as **benchmark actors** — one that builds the PPL, one that runs
the LUnit tests — turns a well-known community project's own pipeline into a governed,
gated, cross-plane-comparable benchmark: the operator's **2-actor icon-editor grid**.

On-host inspection confirmed the spine: the NI container runs **LabVIEW 2026 licensed and
headless** (a known-answer `LabVIEWCLI RunVI` returns 42, VI Server on :3363 — no
interactive activation needed, unlike the Windows plane). The base image ships
`LabVIEWCLI` but **not** g-cli (NI's build action installs g-cli via its own framework).

## Decision

- **Environment**: run the icon-editor benchmarks inside the NI LabVIEW container
  (`nationalinstruments/labview:2026q1-linux`), matching the icon-editor's own CI.
- **Builder actor** (this slice, **LBA-REQ-051**): build the "Editor Packed Library" spec
  with **native `LabVIEWCLI -OperationName ExecuteBuildSpec`** (no g-cli required for the
  build) → `lv_icon.lvlibp`. `ppl-build-benchmark@1` records the machine-independent build
  identity (project + target + build spec + generated artifact + success) so the same build
  is cross-plane comparable; the build time (and `.lvlibp` byte size) are performance
  metrics, not in the hash. Gated fail-closed by `ppl-build-benchmark`.
- **Tester actor** (next slice): run the LUnit suite with `g-cli … lunit`. This requires the
  g-cli launcher, which on Linux is the **Rust proxy built from source** (no prebuilt binary
  ships; the `.vip` installs only the LabVIEW VIs) plus the `sas_workshops_lib_lunit_for_g_cli`
  glue and the `runner_dependencies.vipc` closure.

Both actors' receipts slot into the cross-plane benchmark grid (ADR-0031).

## Consequences

- **The builder actor is proven**: the NI container built `lv_icon.lvlibp` (2.9 MB) from the
  pinned icon-editor project (`9545c483`) in ~59s, `ExecuteBuildSpec operation succeeded`,
  with no g-cli, no dependency-vipc apply, and no dev-mode setup — the icon-editor `resource/`
  source loads and builds clean in the NI image.
- **The tester actor is the next increment**: g-cli's Linux launcher must be built from the
  Rust source in a derived image before `g-cli lunit` can run; this ADR anchors that slice.
- A well-known community project's **actual CI build** is now a governed, fail-closed,
  cross-plane-comparable benchmark, advancing roadmap Phase 2 (the real benchmark suite).
