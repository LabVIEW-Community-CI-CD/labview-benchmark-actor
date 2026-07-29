# ADR-0007: Image-derived timing binds to the pixel-decoded binary strip (cross-platform); colon time is human-only

- Status: Accepted (empirically de-risked cross-platform on 3 authoritative planes — Linux, golden Win11 VM, native Windows; agreed by WIN + LINUX on collab Discussion #2365)
- Owner: WIN
- Traces to: LBA-REQ-003, LBA-REQ-005; constrains the self-test transport-conformance leg
- Standards baseline: `repo-standards-review` v0.2.19
- Absorbed model (self-owned, [ADR-0009](ADR-0009-absorb-mprr-model-self-owned.md)):
  **mprr** — `mprr-self-test-image-derived-timing-v1`, `mprr-self-test-ground-truth-ledger-v1`
  (`binaryStripEncoding` = `mprr-binary-strip-v1`), the
  `extractBinaryStripReadingFromPortableGrayMap` pixel-intensity decoder in
  `scripts/vmLiveStopwatchTimingValidation.js`, and the
  `runReviewCaptureSelfTestTransportConformance` comparator. `Windows.Media.Ocr`
  is used **only** for the human colon-time display.

## Context

The image-derived-timing leg proves that a captured frame's **machine-read**
time matches the authoritative `ground-truth-ledger` tick (the deterministic
`timingAuthority` clock).

**The machine timing channel is the binary strip, decoded by pixel intensity —
not OCR.** mprr's `mprr-binary-strip-v1` renders a row of cells and decodes them
with `extractBinaryStripReadingFromPortableGrayMap` (dark `< 128` → `1`): an
8-bit sync prefix `10100101` + a 24-bit centisecond payload + an 8-bit checksum
(XOR of the payload bytes). The decode is **pure Node**; the frame preprocess
uses `runtime.linuxFfmpeg`. It is therefore **cross-platform** and carries **no**
`Windows.Media.Ocr` dependency.

Two real experiments established "finding-3" — that the human-readable colon
`hh:mm:ss.cc` overlay must NOT be the machine channel:

- **The colon-formatted `hh:mm:ss.cc` time is fragile for OCR.** In the WIN
  `ocr-primitive-proof` (native Windows 11) and the LINUX golden VM, across
  32–120 pt, `Windows.Media.Ocr` drops the colon-laden `00:00:00` prefix, reads
  only the fractional tail (`.12` / `.15`), or reads nothing. Colons + leading
  zeros are the failure mode on both planes.
- **A text-rendered strip OCRs byte-exact, but that is not mprr's channel.** WIN
  separately showed `Windows.Media.Ocr` reads a *text*-rendered strip
  `1010010100000000000000000000000000000000` byte-exact — a valid but *different*
  representation. mprr's real strip is **pixel cells**, so the machine channel
  never needs OCR at all (strictly stronger).
- **The comparator hard-parses `observedText` against `^\d\d:\d\d:\d\d\.\d\d$`**
  (`parseStopwatchTextToCentiseconds` throws otherwise), so `observedText` must
  be the canonical formatted time, never a partial OCR fragment.

## Decision

**The machine timing binds to the pixel-decoded binary strip, not the colon
time.**

- The **binary strip**, decoded by pixel intensity
  (`extractBinaryStripReadingFromPortableGrayMap`), is the machine timing
  channel. `image-derived-timing.timingSamples[].observedCentiseconds` comes
  from that decode.
- `observedText` carries the **canonical, schema-valid** `hh:mm:ss.cc` string
  (from `formatStopwatchTextFromMilliseconds`, so the comparator's
  `^\d\d:\d\d:\d\d\.\d\d$` parse holds).
- Each sample records a `fidelity` block beside the machine value — the decode
  `channel` (`mprr-binary-strip-v1`), `stripBits`, `decodeMethod`, and that colon
  OCR is **human-only**. An optional `rawOcrText` + `corroborationConfidence`
  may score the fragile colon OCR against the centiseconds, but this is
  **non-load-bearing** fidelity garnish, never the timing source.
- The colon-formatted time on the surface remains a **human-only** display.
- The surface producer **must expose a pixel-decodable binary-strip timing
  channel** (`mprr-binary-strip-v1`). A future change to the strip encoding
  requires a successor ADR.

## Consequences

- **+** The entire self-test transport conformance runs **cross-platform**:
  because the strip decode is pixel-intensity (pure Node + `runtime.linuxFfmpeg`)
  and needs no `Windows.Media.Ocr`, the machine timing channel is **not
  windows-bound**. The full leg ran **AUTHORITATIVE on 3 planes** — Linux
  (LINUX), golden Win11 VM (LINUX), and native Windows (WIN cross-check) —
  **byte-identical** (all `maxAbsoluteSkew = 0` on every plane); only a real
  primary-monitor screenshot stays windows-bound, and the self-test does not need
  one. This directly advances the horizon (linux mirrors the windows mprr
  capability).
- **+** The strip round-trips deterministically: cs `10/12/15/999/123456`
  encoded → pixel-decoded through mprr's actual decoder with `0` errors.
- **+** Authoritative timing stays the `ground-truth-ledger` clock; the strip
  decode reproduces it exactly; colon OCR is never the source of truth.
- **−** `observedText` is the **canonical formatted** time, not a raw OCR
  string; the raw colon OCR (if recorded) is explicitly `human-only` fidelity
  evidence, mitigated by the `fidelity` block naming the machine `channel`.
- **−** A full OCR-robust colon-time render recipe (fork **option 2**) is out of
  scope (low-yield vs. the engine's inherent colon/monospace weakness); the
  mprr-native surface-producer render + native crop (fork **option 3**) is a
  later **fidelity upgrade** that tightens the crop but renders the same colon
  glyphs — a complement, **not** a substitute for strip-anchored corroboration.
- **Resolved:** the `corroborationConfidence` metric is pinned as the fraction of
  the fast-changing centisecond digits present (in order) in `rawOcrText`, plus a
  `fractionalTailMatched` flag. The WIN reference
  [`experiments/corroboration-confidence-reference.mjs`](../../../experiments/corroboration-confidence-reference.mjs)
  (validated against the real `ocr-primitive-proof` readbacks + synthetic OCR
  failure modes) was **adopted verbatim by the LINUX golden-VM generator**; the
  golden-VM readbacks re-score **byte-for-byte** on native Windows (the metric is
  deterministic across the VM node and the native-Windows node). The corroboration
  is recorded in the `colon-corroboration.json` **sidecar** — not embedded in the
  machine channel, so `image-derived-timing.json` stays byte-identical across all
  3 planes — and the local gate re-derives it (`colon-corroboration-plane2-scoring`).

## Evidence

- WIN native: [`experiments/ocr-primitive-proof/receipt.json`](../../../experiments/ocr-primitive-proof/receipt.json)
  (`bitStream`/`statusLine` byte-exact; `timeReadbackSensitivity` shows the colon
  fragility by font size).
- LINUX golden VM (plane 2): headless `Windows.Media.Ocr` ~0.45 s/frame; the same
  colon fragility reproduced (`.10` dropped → confidence `0`; `.12`/`.15` →
  confidence `1`, tail matched). Full conformance AUTHORITATIVE with all skews `0`
  ([`experiments/self-test-conformance/receipt-golden-vm.json`](../../../experiments/self-test-conformance/receipt-golden-vm.json)),
  the human-OCR corroboration recorded in
  [`experiments/self-test-conformance/colon-corroboration.json`](../../../experiments/self-test-conformance/colon-corroboration.json).
- LINUX cross-platform (plane 1, the decisive result): `mprr-binary-strip-v1`
  encoder→pixel-decoder round-trips cs `10/12/15/999/123456` through mprr's
  actual decoder with `0` errors; the **full** self-test transport conformance
  ran AUTHORITATIVE **on Linux** end-to-end against WIN's committed ground-truth
  inputs — `authoritativeOutcome = authoritative`, `missingComparisons = 0`, all
  `maxAbsoluteSkew = 0` (imageTiming 3, tdmsShort 5, readerProjection 5).
- WIN native Windows (plane 3): the same comparator ran AUTHORITATIVE on native
  Windows binding the committed relative-ref inputs against the LINUX-generated
  timing/fixture/bus — all 29 skew fields `0`, byte-identical with plane 1
  ([`experiments/self-test-conformance/receipt-windows-crosscheck.json`](../../../experiments/self-test-conformance/receipt-windows-crosscheck.json)).
  This run also **pre-proved** the mprr relative-path portability fix (MR #137):
  the relative `surfaceMetadata.groundTruthLedgerPath` and relative fixture
  `segmentPaths` both resolved on the fix branch.
- Local gate ([`experiments/verify-local-gates.mjs`](../../../experiments/verify-local-gates.mjs))
  enforces the 3-plane result cross-platform (linux-x64 + win32): every plane
  receipt authoritative/`0`-skew and the corroboration sidecar re-scored against
  the reference.
- Fork decision + the sidecar-vs-embedded corroboration design accepted by both
  planes on collab Discussion #2365.
