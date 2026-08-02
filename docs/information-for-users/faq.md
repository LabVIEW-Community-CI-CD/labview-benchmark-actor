# FAQ

> Short answers to recurring questions. Aligns to **ISO/IEC/IEEE 26514:2022 §5**.
> Stable answers fold back into the [User Guide](./user-guide.md) or the route
> docs. See also the [Glossary](./glossary.md) and [FAQ boundary](./conformance-boundary.md).

### Do I need LabVIEW to use the extension?

No — to *explore* it. The extension ships **real** captured benchmark evidence
you can open with no LabVIEW installed (see [Getting Started](./getting-started.md)).
To *capture your own* launch you need LabVIEW on the actor.

### Is my data sent anywhere?

No. Captures and metrics stay **VM-local**; `Show Host Capabilities` and the
webviews run locally. The `lbabus` bus carries inter-actor *communication only*,
never run data, and the mesh does **no central results aggregation**.

### Why exactly 12 FPS?

12 FPS (≈ 83.33 ms/frame) is the shared, frame-locked clock that makes captures
comparable across planes and samplers. Each frame maps 1:1 to one mprr
long-packet. See [Glossary → Exactly 12 FPS](./glossary.md).

### Which platforms are supported?

The extension runs anywhere VS Code runs. Benchmark *actors* target Windows and
Linux (the two comparison planes). The near-term roadmap adds a one-command
**personal Linux golden VM** (Ubuntu 24.04 + LabVIEW Community Edition + VIPM).

### How do I let an agent operate the actor?

Use the Model Context Protocol server and the `lba-open-benchmark-panel`
language-model tool. See the [Command Reference → Agent surface](./command-reference.md)
and [`AGENTS.md`](../../extension-agents/AGENTS.md).

### What is a "mesh-stress" calibration for?

It turns raw per-actor performance counters into a monotone, separable,
repeatable read of *which* actor is stressed and *how much*, so a benchmark
captured on a stressed actor can be discounted. Open it with
**Open Mesh-Stress Calibration** / **Open Concurrent Mesh Board**.

### How do I trust a release before installing it?

Run **Verify Release Provenance** (attestation chain) or **Run Corroboration
Grid** (multi-witness quorum + transparency-log inclusion). An unattested or
un-logged release is refused before install.

### Where do I report an issue or see the plan?

Open an issue on the repository; see [`docs/roadmap.md`](../roadmap.md) for the
direction and the [Information Plan](./plan.md) for how this documentation is
managed.
