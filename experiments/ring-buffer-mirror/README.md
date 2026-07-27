# Experiment: ring-buffer mirror (parity step 2, windows-native half)

Empirical de-risk for the horizon **linux-native mirrors the same mprr
ring-buffer read/replay capability windows-native has (best effort)**.

This experiment proves, end-to-end on a **real native-Windows host**, that the
cross-platform portion of the mprr ring-buffer stack works, and pins exactly
which legs remain Windows-bound.

## What ran (all on windows-native, .NET SDK 8.0.423, node v24)

1. **Reader build** — `ReviewCaptureTransportReader.csproj` (`net8.0` plain) +
   `ReviewCaptureTransportCore` built green (0 warn / 0 err).
2. **Dual-packet WRITER** (`runReviewCaptureSelfTestDualPacketLiveCapture.js`
   → `ReviewCaptureDualPacketSelfTestWriter`, `net8.0`): produced the canonical
   ring buffer — `short.tdms` + `long.tdms` + `dual-packet-manifest.json`,
   `authoritativeOutcome=authoritative`, `packetSchemaId=2.0`,
   `shortPacketCount=20`, `longPacketCount=4`, surface launch **skipped**
   (pre-authored inputs).
3. **RECORDER** (`review-capture-transport-recorder`, `net8.0`): synthesized a
   transport segment + `fixture-manifest.json` + `capture-bus.jsonl` from
   `inputs/operator-events.jsonl` (`transportSchemaId=1.0`, `packetCount=5`:
   cursor 1, click 1, keyboard 1, governed-trigger 2).
4. **Synthetic replay proof** (`runSyntheticVmReplayProof.js`): projected a
   deterministic replay plan through the reader —
   `schemaVersion=synthetic-vm-replay-proof-v1`, `segmentCount=1`,
   `actionCount=5`, logical timeline `0 → 152`, `monotonicPacketSequence=true`,
   `monotonicLogicalTimeline=true`, `fixtureManifestValidation.passed=true`,
   `actionDigestSha256=02a72020f8afaedefc71a09e463696bd70a3abdf454f812014b76a99f3c474e6`.

## Mirror boundary (the finding)

- **Cross-platform** (`net8.0` plain + Node — mirror is tractable): dual-packet
  writer (TDMS ring buffer), transport recorder (segment + fixtureManifest +
  captureBus), reader replay projection, node comparator.
- **Windows-bound** (the only best-effort gaps): (a) surface-producer
  **generation** of the ground-truth-ledger + surface-metadata
  (`net8.0-windows` GDI — and it hits the same WSL-only path-translation gap
  found in `../ocr-primitive-proof`); (b) `Windows.Media.Ocr` image-derived
  timing. Once the inputs exist (pinned here), nothing else is Windows-bound.

## Native-Windows interop workarounds used

1. **Pre-author** `inputs/surface-metadata.json` + `inputs/ground-truth-ledger.json`
   so `ensureSurfaceArtifacts` skips the `net8.0-windows` GDI surface launch
   (which fails on native Windows: *"Failed to translate …ReviewCaptureSelfTestSurface.dll
   to a Windows path"* — the WSL-only translator).
2. `$PSNativeCommandArgumentPassing='Standard'` + a single-quoted JSON for
   `--source-monitor-bounds-json` (bare `\"` escaping mangles the JSON).

## Cross-plane diff protocol (parity step 2, LINUX half)

LINUX runs the SAME recorder over `inputs/operator-events.jsonl` on
linux-native with identical args (`--target-fps 12 --captured-frame-count 48
--source-monitor-bounds-json {"x":0,"y":0,"width":1280,"height":800}`), then the
synthetic replay proof. **If `actionDigestSha256` equals
`02a72020f8afaedefc71a09e463696bd70a3abdf454f812014b76a99f3c474e6`, the
ring-buffer read/replay is byte-deterministic across planes — the mirror is
proven.** The `inputs/` here are the pinned shared retained inputs so both
planes bind identical bytes.

The `inputs/` mirror the mprr fixture contracts in
`tests/unit/reviewCaptureSelfTestDualPacketLiveCaptureDotnet.test.ts` and
`tests/unit/runReviewCaptureSelfTestTransportConformanceScript.test.ts`.
