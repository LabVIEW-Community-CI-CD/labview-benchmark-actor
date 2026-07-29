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
LBA_MPRR_ROOT=/path/to/mprr node produce-conformance.cjs
# on a runtime newer than .NET 8: prefix DOTNET_ROLL_FORWARD=LatestMajor
```

Writes fresh artifacts to `LBA_CONFORMANCE_OUT` (default: a temp dir); the
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

## Plane-3 native-Windows cross-check RESULT (WIN, plane 3)

Executed on native Windows 11 from the mprr `fix/absolute-path-portability-determinism`
branch (fix2), binding the committed `inputs/ground-truth-ledger.json` +
`inputs/surface-metadata.json` (RELATIVE `groundTruthLedgerPath`) against the
LINUX-generated `image-derived-timing.json` + `transport-output/fixture-manifest.json`
+ `transport-output/capture-bus.jsonl`. Full receipt: `receipt-windows-crosscheck.json`.

- `authoritativeOutcome`: **authoritative**; `missingComparisons`: 0; `replayPlanPacketCount`: 5
- `imageTimingComparison.maxAbsoluteSkewMilliseconds`: 0 (3 samples)
- `tdmsShortPacketTimingComparison.maxAbsoluteSkewMilliseconds`: 0 (5 events)
- `readerProjectionComparison.maxAbsoluteSkewMilliseconds`: 0 (5 events)
- Every skew-valued field (29 total) = 0 -> byte-for-byte agreement with plane 1 (LINUX).

**fix2 pre-proven end-to-end on native Windows:** the run used the RELATIVE
`surfaceMetadata.groundTruthLedgerPath` (`ground-truth-ledger.json`) and RELATIVE
fixture `segmentPaths` (`capture-transport/...`), both resolved by the comparator
on the fix2 branch -- concrete evidence for mprr MR #137 ahead of merge.

Re-runnable: the committed receipt is validated by
`experiments/verify-local-gates.mjs` (`windows-crosscheck-receipt-authoritative`).

## Plane-2 golden-VM RESULT (LINUX/me, plane 2) + ADR-0007 colon-OCR corroboration

Executed in the golden Win11 + LabVIEW 2026 Vagrant VM (a 2nd Windows plane),
running the committed portable `produce-conformance.cjs` with the VM's .NET 8 SDK
8.0.423. Full receipt: `receipt-golden-vm.json`.

- `authoritativeOutcome`: **authoritative**; `missingComparisons`: 0; `replayPlanPacketCount`: 5
- image / tdms / reader `maxAbsoluteSkewMilliseconds` = 0 / 0 / 0 -> byte-for-byte
  agreement with planes 1 (LINUX) + 3 (native Windows).

So the portable strip-anchored generator is authoritative on **all three planes**
(LINUX + native-Windows + golden-VM), confirming the machine timing channel is
genuinely cross-platform.

### ADR-0007 human-OCR corroboration (`colon-corroboration.json`)

The optional finding-3 fidelity garnish: the human-only colon `hh:mm:ss.cc` field
was rendered NON-BOLD, OCR'd via `Windows.Media.Ocr` in the golden VM, and scored
with `experiments/corroboration-confidence-reference.mjs` (WIN's metric):

| sample | observedText | rawOcrText | corroborationConfidence | fractionalTailMatched |
| --- | --- | --- | --- | --- |
| stopwatch-010 | 00:00:00.10 | (empty) | 0 | false |
| stopwatch-012 | 00:00:00.12 | .12 | 1 | true |
| stopwatch-015 | 00:00:00.15 | .15 | 1 | true |

The fast centisecond tail corroborates (2 of 3 fully; the `.10` line dropped --
exactly finding-3). This is recorded ONLY as auditable fidelity evidence; the
authoritative `observedCentiseconds` stays strip-anchored (pixel-decoded, 0 skew).

These values live in the **sidecar** `colon-corroboration.json`, kept SEPARATE by
design so `image-derived-timing.json` stays byte-identical across all 3 planes
(the machine channel); its per-sample `fidelity.colonOcr` remains the placeholder
string. The local gate `colon-corroboration-plane2-scoring` re-derives each entry
via `experiments/corroboration-confidence-reference.mjs` and asserts byte-for-byte
agreement (drift or tamper fails the gate).

## Final post-merge run (fix2 on develop, `receipt-final-merged.json`)

After mprr MR #137 merged to `develop` (@ `057ce8d`), the conformance was re-run
on LINUX binding the **committed** `inputs/surface-metadata.json` **directly** --
its RELATIVE `groundTruthLedgerPath` (`ground-truth-ledger.json`) is now resolved
by the comparator's fix2 against `dirname(surfaceMetadataPath)`, so the pre-fix2
absolute-ref workaround is no longer needed.

- `authoritativeOutcome`: **authoritative**; `missingComparisons`: 0; image / tdms
  / reader `maxAbsoluteSkewMilliseconds` = 0 / 0 / 0.
- Binds the byte-identical committed shared inputs (`a7e1182` shapes) end-to-end
  => mprr fix2 confirmed working on merged `develop`, not just the fix2 branch.

### Native-Windows final confirmation (`receipt-windows-final-merged.json`)

Symmetric to the LINUX final run above, the same conformance was re-run on
**native Windows** (plane 3) from the merged `develop` (@ `057ce8d`), binding the
committed `inputs/surface-metadata.json` **directly** -- fix2 resolves its RELATIVE
`groundTruthLedgerPath` against `dirname(surfaceMetadataPath)` on win32 too.

- `authoritativeOutcome`: **authoritative**; `missingComparisons`: 0; image / tdms
  / reader `maxAbsoluteSkewMilliseconds` = 0 / 0 / 0 (all 29 skew fields 0).
- Byte-identical with `receipt-final-merged.json` => both planes agree on the
  MERGED baseline, not just the fix2 branch. The local gate
  `all-plane-receipts-authoritative-zero-skew` now also validates both final
  receipts (5 receipts total when present).
