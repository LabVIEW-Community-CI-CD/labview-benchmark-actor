# Glossary

> One definition source for the project's domain terms. Aligns to
> **ISO/IEC/IEEE 26514:2022 §5** (terminology + findability). Terms trace to the
> requirements ([`srs.md`](../requirements/srs.md)) and architecture
> ([`overview.md`](../architecture/overview.md)).

| Term | Definition |
| --- | --- |
| **Benchmark actor** | An instance of the extension (on a VM, codespace, or host) that drives a benchmark run and emits a schema-versioned result. |
| **Actor mesh** | Multiple benchmark actors coordinating over `lbabus` for on-demand, reproducible cross-plane comparison (no central data aggregation). |
| **`lbabus`** | The TCP/UDP coordination bus. Carries **inter-actor communication only** — never run data. |
| **Golden VM** | A provisioned, activated, re-importable benchmark VM. The Windows golden box exists today; the personal Linux golden VM is the near-term roadmap slice (`LBA-REQ-033`). |
| **Plane** | A comparison axis: operating system (Windows-LabVIEW vs Linux-LabVIEW), physical hardware, or LabVIEW version/configuration. |
| **Cross-plane comparison** | Comparing the same benchmark across planes; the deterministic `seriesHash` must match, while machine cost may differ. |
| **Exactly 12 FPS** | The frame-locked capture cadence (1000/12 ≈ 83.33 ms/frame). The shared clock across every plane + sampler; each frame maps to one mprr long-packet. |
| **mprr** | The ring-buffer model for VM-local frame/metric storage: short-packets (metrics) index long-packets (image payloads). Images never cross the bus. |
| **Frame correlator** | The webview that plots metric curves over the frame timeline with a draggable time cursor bound to the captured screenshot. |
| **Performance signature** | The repetitive + outlier features of an actor's performance-counter series across repeated runs — its fingerprint at a stress level. |
| **Stress ladder / rung** | The monotone commanded stress levels idle → light → medium → heavy → saturate; a rung is one level. |
| **Calibration curve** | Per counter-feature, the expected value + tolerance band per rung, scored monotone / separable / repeatable. |
| **Inverse read** | Mapping an observed signature back to its inferred stress rung with a confidence. |
| **Corroboration grid** | The multi-witness release-corroboration mechanism: independent witnesses agree on deterministic anchors before a release is installable. |
| **Verify-before-install / -consume** | Refusing to install/consume a release until its attestation chain (and transparency-log inclusion) verifies. |
| **VIPM** | VI Package Manager — installs LabVIEW add-on packages; part of the personal golden VM. |
| **LabVIEWCLI** | NI's headless LabVIEW command-line runner (`RunVI`, `RunVIAnalyzer`, …); the Linux actor's automation + activation-confirmation runtime. |
| **MCP** | Model Context Protocol — the tool surface an agent uses to drive the actor. |
| **Correspondence graph** | The fail-closed traceability rules (TR-1/AD-1/VW-1/II-1/II-2/PR-1/CM-1) linking requirements ⇄ tests ⇄ ADRs ⇄ views ⇄ information items. |
