# ADR-0007: Image-derived timing binds to the OCR-robust binary strip; colon time is human-only

- Status: Accepted (empirically de-risked; agreed by WIN + LINUX on collab Discussion #2365)
- Owner: WIN
- Traces to: LBA-REQ-003, LBA-REQ-005; constrains the self-test transport-conformance leg
- Standards baseline: `repo-standards-review` v0.2.19
- External canonical reference: **mprr** (`svelderrainruiz/mprr`, `develop`) —
  `mprr-self-test-image-derived-timing-v1`, `mprr-self-test-ground-truth-ledger-v1`
  (`binaryStripEncoding` = `mprr-binary-strip-v1`), and the
  `runReviewCaptureSelfTestTransportConformance` comparator; **Windows.Media.Ocr**.

## Context

The image-derived-timing leg corroborates that a captured frame's **visible**
time matches the authoritative `ground-truth-ledger` tick (the deterministic
`timingAuthority` clock). It is a **fidelity cross-check**, not the timing
source of truth.

Two independent real experiments — the WIN-plane `ocr-primitive-proof` on a
native Windows 11 host and the LINUX-plane headless golden-VM OCR de-risk —
converged on the same empirical finding ("finding-3"):

- **`Windows.Media.Ocr` reads the OCR-robust monospace binary strip and the
  word status line BYTE-EXACT.** WIN evidence: bit strip
  `1010010100000000000000000000000000000000` (rendered == OCR, exact) and
  `Waiting for a controlled click target or trigger.` (exact). The strip's
  leading `10100101` is exactly the mprr `binaryStripEncoding` prefix.
- **The colon-formatted `hh:mm:ss.cc` time is fragile for OCR.** Across
  32–120 pt, bold and regular, whole-image and tightly cropped, the engine
  drops the colon-laden `00:00:00` prefix, reads only the fractional tail
  (`.12` / `.15`), or reads nothing. Colons + leading zeros are the failure
  mode on both planes.
- **The comparator hard-parses `observedText` against `^\d\d:\d\d:\d\d\.\d\d$`**
  (`parseStopwatchTextToCentiseconds` throws otherwise), so a partial OCR
  fragment cannot be `observedText` directly.

Headless `Windows.Media.Ocr` itself is viable (~0.45 s/frame via the three
injected native-Windows interop shims); the OCR **engine** is not the risk —
the **colon time glyphs** are.

## Decision

**The machine timing corroboration binds to the OCR-robust binary strip, not
the colon time.**

- The **binary strip** (already modeled by `binaryStripEncoding` =
  `mprr-binary-strip-v1`, read byte-exact on both planes) is the machine-read
  timing channel. `image-derived-timing.timingSamples[].observedCentiseconds`
  is corroborated from the strip readback.
- `observedText` carries the **canonical, schema-valid** `hh:mm:ss.cc` string
  (so the comparator's `^\d\d:\d\d:\d\d\.\d\d$` parse holds); it is a **derived
  expected** value, not the raw OCR string.
- The **raw OCR readback** (`rawOcrText`) and a **`corroborationConfidence`**
  are recorded **beside** each sample as auditable fidelity evidence (the OCR
  fractional tail `.12` genuinely corroborates centiseconds `12`).
- The colon-formatted time on the surface remains a **human-only** display; it
  is **not** the machine timing source.
- `image-derived-timing` is a **tolerant map** of OCR onto the schema: real
  render + real `Windows.Media.Ocr` + real binary-strip corroboration.
- The surface producer **must expose an OCR-robust machine timing channel** (the
  binary strip). A future change to the strip encoding requires a successor ADR.

## Consequences

- **+** Keeps the OCR leg **real and cross-plane honest** without demanding
  perfect colon OCR that `Windows.Media.Ocr` cannot reliably do.
- **+** The strip is already in the schema and reads **byte-exact on both
  planes**, so the corroboration is cross-plane deterministic.
- **+** Authoritative timing stays the `ground-truth-ledger` clock; OCR is a
  corroboration, never the source of truth.
- **−** `observedText` is a **derived** canonical value, not the raw OCR string;
  mitigated by recording `rawOcrText` + `corroborationConfidence` as auditable
  evidence beside it.
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
  (`bitStream`/`statusLine` byte-exact; `timeReadbackSensitivity` by font size).
- LINUX golden VM: headless `Windows.Media.Ocr` ~0.45 s/frame; the same colon
  fragility reproduced (48 pt → fractional tail only; 120 pt → nothing).
- Fork decision accepted by both planes on collab Discussion #2365.
