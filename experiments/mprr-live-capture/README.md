# Experiment: mprr dual-packet live capture (headless, storage/timeline de-risk)

Grounds: **LBA-REQ-003, LBA-REQ-005, LBA-REQ-009** and **ADR-0005** against the
real **mprr** transport (`svelderrainruiz/mprr` `develop`, frozen TDMS `1.0`).

## What this proves

The labview-benchmark-actor viewer's core data path — *drag the time cursor to
time T → show the captured picture at T* — is realizable on mprr's frozen
contract, and the VM-local dual-packet storage model is real, **without a golden
VM, a display, or the `/mnt/e` surface**. A headless run of mprr's own
`runReviewCaptureSelfTestDualPacketLiveCapture.js` (driven by the two synthesized
inputs here) produced real `short.tdms` + `long.tdms` and these receipts:

- **dual-packet-contract**: `authoritative` — short/long streams, short-packet is
  the primary analysis surface, schema `1.0` frozen (successor `2.0` reserved,
  mprr MPRR-REQ-093 → LBA **consumes, never mutates**).
- **buffering-policy**: `authoritative` — exact governed budgets short
  **16 MiB / 32768 packets**, long **256 MiB / 512 packets**, degradation
  preserves short-packet continuity (mprr ADR-0024). Grounds LBA-REQ-009.
- **live-capture**: `authoritative` — 92 short packets + 20 long packets;
  `short.tdms` ≈ 9.7 KB (scrub-cheap), `long.tdms` ≈ 1.15 MB (20 image payloads,
  fetch-on-demand).
- **short-packet-analysis-summary**: the viewer timeline on real bytes — each
  entry carries `timingTicks64` (the scrub axis, 100 ns authority), `frameId`,
  `payloadDescriptorId` (the image join), plus labels / annotations / triggers.
- **correlation-receipt**: **20/20 frames** `correlationOutcome=authoritative`,
  `driftClass=none`; each `frameId → payloadDescriptorId (1001..1020)` with
  short-packet `frame-start`/`frame-end` bracketing the long-packet payload;
  `startSkewTicks=2` (measured trigger→writer skew, mprr MPRR-REQ-087).

Only the **image-fidelity** leg (image-derived timing = a real rendered
fiducial/stopwatch or real LabVIEW frames vs the ground-truth ledger, inside
`review:capture:self-test:conformance`) needs a real render — the mprr surface
producer is `net8.0-windows` GUI. That leg is de-risked on the **golden VM**
(LINUX plane); its inputs are shipped back for a Windows conformance cross-check.

## Reproduce (any box with Node ≥ 18 + .NET SDK ≥ 8)

```sh
# in a clone of svelderrainruiz/mprr (develop)
node scripts/runReviewCaptureSelfTestDualPacketLiveCapture.js \
  --surface-metadata-path   <this-dir>/surface-metadata.json \
  --ground-truth-ledger-path <this-dir>/ground-truth-ledger.json \
  --output-dir <tmp>/live --frame-count 20 --json
```

Windows note: install the SDK user-local without elevation via
`dotnet-install.ps1 -Channel 8.0 -InstallDir $env:USERPROFILE\.dotnet`, then set
`$env:DOTNET_ROOT` and prepend it to `PATH` for the session.

## Determinism cross-check

Raw `.tdms` bytes differ per run (embedded `runId`/wall-clock), so compare the
**structure**, not the bytes: `evidence/short-packet-analysis-summary.json`
(frame graph + `timingTicks64` spacing) and
`evidence/dual-packet-correlation-receipt.json` (`frameId → payloadDescriptorId`,
`correlationOutcome`, `driftClass`) should match across platforms. A Windows run
(node v24, .NET 8) is retained under `evidence/`; a Linux run (node v22,
.NET 10) is expected to match structurally.

## Files

- `surface-metadata.json`, `ground-truth-ledger.json` — synthesized inputs (from
  mprr's own test constructors); the only inputs the writer path needs.
- `evidence/*.json` — retained receipts from the Windows headless run. The
  `short.tdms` / `long.tdms` binaries are intentionally **not** committed (size).
