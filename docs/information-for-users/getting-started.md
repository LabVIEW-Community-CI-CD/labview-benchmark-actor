# Getting Started

> A task-first path to your first LabVIEW launch benchmark. Aligns to
> **ISO/IEC/IEEE 26514:2022 §5** (task-oriented information for users). For the
> full behavior detail see the [User Guide](./user-guide.md); for every command
> see the [Command Reference](./command-reference.md).

## Who this is for

The **LabVIEW community member** who wants a working benchmark actor (see the
[Audience and Task Model](./audience-and-task-model.md)). If you are an
**agent**, drive these same steps through the MCP server + the
`lba-open-benchmark-panel` language-model tool.

## 1. Install the extension

Install `labview-benchmark-actor` from the VS Code Marketplace, or install the
`ext-v*` `.vsix` from a GitHub Release. It activates with no configuration and
adds the **LabVIEW Benchmark Actor** commands to the Command Palette.

## 2. See what your host can do

Run **Show Host Capabilities** (`labviewBenchmarkActor.showCapabilities`) to
confirm the actor sees your host. This never leaves your machine.

## 3. Open the shipped benchmark evidence

Before capturing your own run, explore the **real** evidence the extension ships:

- **Open Benchmark Run** / **Open Benchmark Trend** — a single captured
  LabVIEW-launch run and a multi-run trend.
- **Open Benchmark Frame Correlator** — scrub a red time cursor across the
  CPU / RAM / disk (and v2 performance-counter) curves and see the captured
  screenshot at each frame.
- **Open Mesh-Stress Calibration** / **Open Concurrent Mesh Board** — the
  mesh-stress analysis views (the calibration curve and the live actor board).

## 4. Capture your own launch

On an actor that has LabVIEW, run **Capture LabVIEW Launch**, launch LabVIEW,
then **Stop LabVIEW Capture**. The extension records the screen at exactly
**12 FPS** and samples CPU / RAM / disk, then opens the frame correlator on your
capture. Everything stays VM-local.

## 5. (Optional) Verify a release before installing

For a corroborated release, run **Verify Release Provenance** to check the
attestation chain, or **Run Corroboration Grid** for the full multi-witness
decision. See [Verify a release](./user-guide.md) and the
[Glossary](./glossary.md) for the trust model.

## Where to go next

| You want to… | Go to |
| --- | --- |
| Understand every command | [Command Reference](./command-reference.md) |
| Learn the review workflow in depth | [User Guide](./user-guide.md) |
| Look up a term | [Glossary](./glossary.md) |
| Troubleshoot | [FAQ](./faq.md) |
| See where the project is heading | [`docs/roadmap.md`](../roadmap.md) |
