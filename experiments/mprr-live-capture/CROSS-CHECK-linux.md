# Determinism cross-check — Linux run (LINUX lane)

Reproduced WIN's headless dual-packet live capture on native Linux and compared
**structure** against [`evidence/`](evidence/) (the Windows run). Result:
**cross-platform match** — mprr's dual-packet storage + timeline + correlation
contract is deterministic on both planes, independent of any golden VM.

## Environment

- Linux (native), node **v22.22.1**, .NET SDK **10.0.110**.
- The mprr writer targets **`net8.0`**; I ran it on the installed .NET **10**
  runtime via `DOTNET_ROLL_FORWARD=LatestMajor` — **no .NET 8 install required**
  on this box (contrast: WIN installed the .NET 8 SDK user-local on Windows).
- Command, from a clone of `svelderrainruiz/mprr` `develop` @ `7328120`:

```sh
DOTNET_ROLL_FORWARD=LatestMajor node scripts/runReviewCaptureSelfTestDualPacketLiveCapture.js \
  --surface-metadata-path   <experiments/mprr-live-capture>/surface-metadata.json \
  --ground-truth-ledger-path <experiments/mprr-live-capture>/ground-truth-ledger.json \
  --output-dir <tmp>/live --frame-count 20 --json
```

## Result

- Run outcome: **`authoritative`**, **92 short packets + 20 long packets**
  (identical counts to the Windows run).
- TDMS sizes match: `short.tdms` **9740 B**, `long.tdms` **1154240 B**
  (Windows: ≈ 9.7 KB / 1.15 MB).
- Structural comparison (per-run `runId`/wall-clock normalized) — **3/3 MATCH**:
  - `dual-packet-correlation-receipt.json` — 4384 B canonical, identical
    (20/20 frames `correlationOutcome=authoritative`, `driftClass=none`,
    `frameId -> payloadDescriptorId 1001..1020`, `startSkewTicks=2`).
  - `short-packet-analysis-summary.json` — 12976 B canonical, identical
    (frame graph + `timingTicks64` spacing = the viewer scrub axis).
  - `dual-packet-manifest.json` — 1134 B canonical, identical
    (`transportSchemaId` + `packetSchemaId` agree cross-platform).

Linux structural receipts are retained in [`evidence-linux/`](evidence-linux/)
(the `short.tdms` / `long.tdms` binaries are intentionally not committed, per the
runbook). Only the **image-fidelity** leg (a real render + image-derived timing
vs the ground-truth ledger, inside `review:capture:self-test:conformance`) still
needs a real render, and is the narrowed job of the golden VM.
