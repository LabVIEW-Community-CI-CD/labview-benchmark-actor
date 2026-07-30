# Absorbed model: mprr ring-buffer & timing (`experiments/mprr-ring/`)

This directory is the **self-owned, dependency-free absorption** of the **mprr**
ring-buffer and timing model into `labview-benchmark-actor`. The `mprr` name is retained
for the model; the model is **owned in-repo** and no longer tracks the external
`svelderrainruiz/mprr` repository. See
[ADR-0009](../../docs/architecture/adr/ADR-0009-absorb-mprr-model-self-owned.md) for the
absorption decision, and
[ADR-0005](../../docs/architecture/adr/ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md)
/ [ADR-0007](../../docs/architecture/adr/ADR-0007-image-derived-timing-binary-strip.md)
for how the model is used (VM-local storage; image-derived timing).

Everything here is a **faithful ESM mirror** with **no runtime dependency** — Node
built-ins only — so both planes (LINUX and native-Windows) share one testable model and a
benchmark run is comparable across planes through the benchmark store. The historical mprr
provenance (`MPRR-REQ-*`, ADR-0024 dual-packet policy, the frozen TDMS-compatible `1.0`
transport) is cited in each source as design lineage, not as an external contract.

## Modules

| File | Model | Provenance |
| --- | --- | --- |
| [mprrRing.mjs](mprrRing.mjs) | Windows zero-copy rolling-block **short-packet ring** (`labview-benchmark-actor/mprr-short-ring@v1`): one preallocated buffer, split-copy on wrap, 100 ns `timingTicks64` authority, admission control + block-boundary variation gates. | MPRR-REQ-094 / 104–119 |
| [mprrDualPacket.mjs](mprrDualPacket.mjs) | **Dual-packet correlation + degradation**: each frame has a short (timing, always admitted) and optional long (payload) packet; the policy protects short-packet continuity before long-packet completeness, failing closed at the short-protection boundary. | MPRR-REQ-094 / 110 / 111 |
| [mprrPacketHarness.mjs](mprrPacketHarness.mjs) | **Rate-profile harness**: deterministic short-packet streams per named load profile, driven through the absorbed ring to exercise its invariants across load shapes. | MPRR-REQ-115–119 |
| [mprrViewerSeries.mjs](mprrViewerSeries.mjs) | **Viewer projection**: projects a short-ring ingest result into the exact `[{ t, v }]` series the shipped viewer renders, plus a stable `seriesHash` — the single projection shared by the viewer driver, screenshot harness, and benchmark store, so cross-plane comparison is byte-exact. | — |

## Gates

Each model has a `verify-*.mjs` gate that asserts it has teeth; all are aggregated by
`experiments/verify-local-gates.mjs`:

- [verify-mprr-ring.mjs](verify-mprr-ring.mjs) — ring write/wrap/copy-view, block boundaries, admission.
- [verify-mprr-dual-packet.mjs](verify-mprr-dual-packet.mjs) — correlation + degradation policy.
- [verify-mprr-packet-harness.mjs](verify-mprr-packet-harness.mjs) — rate profiles across load shapes.

Determinism is the contract: identical packets yield an identical series and an identical
`seriesHash` on both planes, which is the anchor the cross-plane screenshot comparison
rests on (cross-OS pixel identity is not guaranteed).
