# ADR-0033: Icon-editor CI benchmarks in the NI LabVIEW container (2-actor grid — build + test)

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "make a grid of 2 actors that one builds the ppl and the other tests over lunit; research how the icon editor does it on linux") + agent
- Relates to: LBA-REQ-051, LBA-REQ-052, LBA-REQ-053, ADR-0031 (cross-plane comparison / benchmark grid), docs/roadmap.md (Phase 2 — the real benchmark suite), ni/labview-icon-editor CI

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
- **Tester actor** (**LBA-REQ-053**): run the LUnit suite with
  `g-cli … lunit -- -r <report> lv_icon_editor.lvproj`. This uses the g-cli launcher (the Rust
  proxy of LBA-REQ-052) and the LUnit test framework installed via the project's
  **`icon-editor-developer.vipc`** — the correct developer/test dependency. It does **not** use
  the CI-runner `runner_dependencies.vipc`, which additionally bundles the g-cli VIPM package
  (unneeded — the launcher is built from Rust) and the PowerShell-automation glue; the
  `g-cli lunit` tool VI (`vi.lib/G CLI Tools/lunit.vi`) comes from the LUnit CLI packages that
  `icon-editor-developer.vipc` pulls in. `lunit-test-benchmark@1` records the machine-independent
  test inventory (sorted class/case set + suite structure), so the same suite is cross-plane
  comparable; the pass/fail/error outcomes are environment-dependent and recorded but not hashed.
  Gated fail-closed by `lunit-test-benchmark`.

Both actors' receipts slot into the cross-plane benchmark grid (ADR-0031).

## Consequences

- **The builder actor is proven**: the NI container built `lv_icon.lvlibp` (2.9 MB) from the
  pinned icon-editor project (`9545c483`) in ~59s, `ExecuteBuildSpec operation succeeded`,
  with no g-cli, no dependency-vipc apply, and no dev-mode setup — the icon-editor `resource/`
  source loads and builds clean in the NI image.
- **The tester actor is proven**: the Rust-built g-cli (static musl, LBA-REQ-052) ran
  `g-cli lunit` against `lv_icon_editor.lvproj` on the golden VM `lba-golden` and produced a
  well-formed JUnit report — 4 LUnit classes / 25 cases discovered + executed (10 passed,
  2 failed, 8 errored, 5 setup/helper). The 8 errors are the window-geometry / INI-settings
  tests that need a real editor window, unavailable under headless xvfb — an environment
  property, not a tester-actor defect. The **2-actor icon-editor grid is complete** (build + test).
- A well-known community project's **actual CI build + test** is now a governed, fail-closed,
  cross-plane-comparable benchmark, advancing roadmap Phase 2 (the real benchmark suite).
