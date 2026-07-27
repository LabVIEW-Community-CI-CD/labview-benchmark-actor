# ADR-0007: Image-derived timing binds to the pixel-decoded binary strip (cross-platform); colon time is human-only

- Status: Accepted (empirically de-risked cross-platform; agreed by WIN + LINUX on collab Discussion #2365)
- Owner: WIN
- Traces to: LBA-REQ-003, LBA-REQ-005; constrains the self-test transport-conformance leg
- Standards baseline: `repo-standards-review` v0.2.19
- External canonical reference: **mprr** (`svelderrainruiz/mprr`, `develop`) —
  `mprr-self-test-image-derived-timing-v1`, `mprr-self-test-ground-truth-ledger-v1`
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
  windows-bound**. LINUX proved the full leg **AUTHORITATIVE end-to-end on
  Linux** (all skews `0`); only a real primary-monitor screenshot stays
  windows-bound, and the self-test does not need one. This directly advances the
  horizon (linux mirrors the windows mprr capability).
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
- **Open:** the exact `corroborationConfidence` metric (e.g. the fraction of the
  fast-changing centisecond digits present in `rawOcrText`) — pin it against
  mprr's `image-derived-timing` generator when the LINUX golden-VM ships it. A
  WIN reference implementation, validated against the real `ocr-primitive-proof`
  readbacks, lives at
  [`experiments/corroboration-confidence-reference.mjs`](../../../experiments/corroboration-confidence-reference.mjs)
  (also exercised by the local gate).

## Evidence

- WIN native: [`experiments/ocr-primitive-proof/receipt.json`](../../../experiments/ocr-primitive-proof/receipt.json)
  (`bitStream`/`statusLine` byte-exact; `timeReadbackSensitivity` shows the colon
  fragility by font size).
- LINUX golden VM: headless `Windows.Media.Ocr` ~0.45 s/frame; the same colon
  fragility reproduced (48 pt → fractional tail only; 120 pt → nothing).
- LINUX cross-platform (the decisive result): `mprr-binary-strip-v1`
  encoder→pixel-decoder round-trips cs `10/12/15/999/123456` through mprr's
  actual decoder with `0` errors; the **full** self-test transport conformance
  ran AUTHORITATIVE **on Linux** end-to-end against WIN's committed ground-truth
  inputs — `authoritativeOutcome = authoritative`, `missingComparisons = 0`, all
  `maxAbsoluteSkew = 0` (imageTiming 3, tdmsShort 5, readerProjection 5).
- Fork decision accepted by both planes on collab Discussion #2365.
