# LBA self-test transport conformance -- LINUX authoritative run (OPTION 1, binary-strip-anchored)

Cross-platform proof that the mprr `mprr-self-test-transport-conformance-v1`
image-fidelity leg is **not** Windows-bound. See ADR-0007.

## Result (LINUX, native)

`receipt-linux.json`:

- `schemaVersion`: `mprr-self-test-transport-conformance-v1`
- `authoritativeOutcome`: **authoritative**
- `missingComparisons`: 0, `replayPlanPacketCount`: 5
- `imageTimingComparison.maxAbsoluteSkewMilliseconds`: 0 (3 samples)
- `tdmsShortPacketTimingComparison.maxAbsoluteSkewMilliseconds`: 0 (5 events)
- `readerProjectionComparison.maxAbsoluteSkewMilliseconds`: 0 (5 events)

## Why it is cross-platform (the horizon proof)

The image-derived-timing MACHINE channel is the `mprr-binary-strip-v1` strip,
**decoded by pixel intensity**, not by OCR:

- 40 blocks = 8 sync (`10100101`) + 24 payload (centiseconds, big-endian) + 8
  checksum (`((cs>>16)&0xff) ^ ((cs>>8)&0xff) ^ (cs&0xff)`); a bit cell is `1`
  when its average intensity `< 128`.
- Decoded by mprr's own `extractBinaryStripReadingFromPortableGrayMap`
  (`scripts/vmLiveStopwatchTimingValidation.js`) -- pure Node; the PNG->graymap
  preprocess uses `runtime.linuxFfmpeg`. No `Windows.Media.Ocr`.
- `observedText` = `formatStopwatchTextFromMilliseconds(observedCentiseconds*10)`
  -> canonical `hh:mm:ss.cc` (e.g. `00:00:00.10`) that satisfies the comparator
  parse `^\d\d:\d\d:\d\d\.\d\d$`.

`Windows.Media.Ocr` remains **human colon-display only** (finding-3) and is
**not** load-bearing for the machine timing. Only a real primary-monitor
screenshot is Windows-bound, which the self-test does not need.

Encode -> render -> decode round-trip verified for cs `10/12/15/999/123456`
through mprr's actual decoder (0 errors).

## Artifacts (snapshot of the authoritative run)

- `image-derived-timing.json` -- 3 timingSamples; each `fidelity.channel` =
  `mprr-binary-strip-v1` with the exact `stripBits` + PGM path + `decodeMethod`;
  `colonOcr` marked `human-only-not-machine-timing`.
- `strips/stopwatch-0{10,12,15}.pgm` -- the rendered binary-strip gray maps.
- `transport-output/` -- recorder output: `fixture-manifest.json` +
  `capture-bus.jsonl` (both reference the segment by RELATIVE path) +
  `capture-transport/*.tdms` + `operator-event-transport-receipt.json`.
- `receipt-linux.json` -- the conformance receipt (absolute run paths sanitized
  to `<OUT>`).
- `inputs/` -- the canonical shared inputs (owned upstream; not modified here).

## Reproduce

```
VIHS_MPRR_ROOT=/path/to/mprr node produce-conformance.cjs
# on a runtime newer than .NET 8: prefix DOTNET_ROLL_FORWARD=LatestMajor
```

Writes fresh artifacts to `VIHS_CONFORMANCE_OUT` (default: a temp dir); the
committed snapshot is never clobbered.

## Cross-plane cross-check (3 planes)

Plane 1 = this LINUX run (authoritative, all skews 0). Plane 3 = native Windows
(WIN) runs the comparator binding the committed `inputs/` (relative-ref
surface-metadata, via the mprr fix2 relative-path resolution) against the
`image-derived-timing.json` + `transport-output/fixture-manifest.json` +
`capture-bus.jsonl` here. All generated paths are relative, so no rebasing is
needed. That pass also pre-proves mprr fix2 end-to-end ahead of MR #137.

## Note (pre-fix2 workaround used by this LINUX run)

The current mprr `develop` comparator requires `surfaceMetadata.groundTruthLedgerPath`
to byte-equal the resolved absolute `--ground-truth-ledger-path`; the generator
therefore writes a local surface-metadata with an ABSOLUTE ledger ref. mprr MR
#137 fix2 resolves a RELATIVE ledger ref against `dirname(surfaceMetadataPath)`,
so the committed `inputs/surface-metadata.json` (relative ref) binds directly on
the fix2 branch -- the basis of the plane-3 cross-check.
