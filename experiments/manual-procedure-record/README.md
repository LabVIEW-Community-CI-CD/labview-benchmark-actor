# manual-procedure deterministic record (golden-box iteration visual-diff)

An **independent** verification method (co-designed with the WIN plane) that measures **visual
differences between golden-box iterations** (v1 vs v2) — deltas the CI gates and the extension's
own screenshot-hash cannot see. It records one **manual** reviewer-procedure session
(TC-00..TC-10) run on a golden box *after the extension is installed*, seals it deterministically,
and diffs two sealed records.

Self-owned per **ADR-0009 (absorb the mprr model, self-owned)** — this reuses the mprr correlation
*pattern* and the [`../ocr-primitive-proof`](../ocr-primitive-proof) scaffolding, but emits its OWN
`manual-procedure-record-v1` record here; it does **not** depend on the external mprr repo.

## Why not just OCR a stopwatch

[`../ocr-primitive-proof`](../ocr-primitive-proof) finding #3: whole-image `Windows.Media.Ocr`
**dropped** a colon-formatted stopwatch time at 64/48/40 pt and misread it at 32 pt (`00`->`ee`),
while a **plain digit stream read byte-exact**. So this design deliberately avoids both fuzzy OCR
and colon-formatted clocks:

- **The stopwatch is a monotonic counter surfaced by the extension viewer** (`media/viewer.js`) as
  plain, high-contrast, non-bold digits. We render the glyphs, so reading them is a **known-digit
  template match** — 100% deterministic, and **Linux-native** (no Windows-only `Windows.Media.Ocr`).
- The counter **is** the mprr time-anchor, so the record is self-consistent — there is no external
  clock to correlate against.

## Flow

```
viewer counter starts (visible plain digits)  ──►  session runs TC-00..TC-10
        │                                                   │
        │                                      WIN captures an MPRR-style frame ring
        ▼                                                   ▼
LINUX known-digit template read of each frame's counter  ──►  correlate read-series vs the
                                                              viewer's EMITTED counter series
                                                   (expected == read, mismatches == 0)
                                                                    │  matched
                                                                    ▼
              SEAL: discard raw frames; keep { anchor, per-frame perceptual fingerprint,
                     per-frame integrity hash } as manual-procedure-record-v1
                                                                    │
                                                                    ▼
   cross-iteration verify = frame-diff of two sealed records, paired by caseId (TC-xx):
        Hamming distance between per-case settled perceptualFingerprints  ──►  visual-delta MAGNITUDE
```

## Two distinct artifacts (do not conflate)

1. **Correlation ground truth** = the viewer's **emitted monotonic counter series** (wall-time). The
   record only **seals** when the known-digit read of the on-screen counter matches it
   (`mismatches == 0`). The counter is the INTRA-session anchor — **not** the cross-session pairing key.
2. **Cross-iteration diff artifact** = a per-frame **perceptual fingerprint**. Record-level
   `fingerprintAlgo` = **`dhash-64`** (integer-only → bit-identical cross-plane), computed by the shared
   `fingerprint.mjs`. A *cryptographic* hash is binary (identical / not); a perceptual fingerprint yields
   **magnitude** (Hamming distance), which is what "visual deltas" needs. A crypto `integrityHash`
   is *also* kept, but only to prove the discarded raw frame existed unaltered.
3. **Pairing key** = **`caseId`** (TC-xx). Two human sessions run at different speeds, so the counter
   won't align across iterations; the frame-diff pairs by `caseId` + the per-case **`settled`** frame.

## Seal = closed/cleared

On correlation the record is **CLOSED**: raw frames are **discarded** (`seal.rawDiscarded: true`),
and only the anchor + per-frame fingerprints + integrity hashes remain — the storage/privacy
property the operator asked for. `seal.recordHash` is the tamper-evident id.

Schema: [`manual-procedure-record-v1.schema.json`](manual-procedure-record-v1.schema.json).

## Slice split (cross-plane)

| Plane | Owns |
| --- | --- |
| **LINUX** | the viewer monotonic counter (`media/viewer.js`); the Linux-native **known-digit template reader**; **correlate -> seal -> clear**; this **`manual-procedure-record-v1` schema** (the seam). |
| **WIN** | VMware capture (`vmrun captureScreen` w/ actor creds); the stopwatch overlay/compositing at session start; the **cross-iteration frame-diff** that consumes two sealed records. |

Both planes MUST use the same `fingerprintAlgo` so the frame-diff is comparable.

## Status

Draft-for-alignment (proposal). Next: the Linux known-digit template reader + a
`correlate-seal` producer that emits a conformant record, then WIN's frame-diff consumer.
