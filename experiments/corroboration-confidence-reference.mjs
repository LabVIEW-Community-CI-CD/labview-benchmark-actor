// labview-benchmark-actor — corroborationConfidence reference implementation.
//
// Reference for ADR-0007 (image-derived timing binds to the OCR-robust binary
// strip; the colon-formatted hh:mm:ss.cc time is human-only). The authoritative
// per-sample centiseconds come from the byte-exact binary strip; this metric
// scores how much the FRAGILE colon-time OCR readback (rawOcrText) still
// corroborates the fast-changing centisecond digits, recorded beside the sample
// as auditable fidelity evidence (never as the timing source).
//
// This is the WIN-plane reference the LINUX golden-VM image-derived-timing
// generator (plan item b) can adopt verbatim. Dependency-free ESM (Node >= 18).
//
// Contract, per timing sample:
//   corroborationConfidence(canonicalObservedText, rawOcrText) -> {
//     fast,                  // the 2 centisecond digits of the canonical time
//     matchedFastDigits,     // how many of those 2 digits appear, in order, in raw
//     corroborationConfidence, // matchedFastDigits / 2, in [0,1]
//     fractionalTailMatched  // raw ends with "." + fast (e.g. ".34")
//   }
// Rationale (ADR-0007): the colon prefix is low-information and OCR-hostile; the
// centisecond tail is the meaningful fast-changing signal and is what actually
// reads back (real data below). observedCentiseconds stays strip-anchored.

import { pathToFileURL } from 'node:url';

const CANONICAL_TIME_RE = /^\d\d:\d\d:\d\d\.(\d\d)$/;

export function corroborationConfidence(canonicalObservedText, rawOcrText) {
  const m = CANONICAL_TIME_RE.exec(String(canonicalObservedText ?? ''));
  if (!m) {
    throw new Error(`canonicalObservedText must match hh:mm:ss.cc, got ${JSON.stringify(canonicalObservedText)}`);
  }
  const fast = m[1]; // the centisecond pair, e.g. "34"
  const raw = String(rawOcrText ?? '');
  let cursor = -1;
  let matchedFastDigits = 0;
  for (const digit of fast) {
    const at = raw.indexOf(digit, cursor + 1);
    if (at > cursor) {
      matchedFastDigits += 1;
      cursor = at;
    }
  }
  return {
    fast,
    matchedFastDigits,
    corroborationConfidence: matchedFastDigits / fast.length,
    fractionalTailMatched: raw.endsWith(`.${fast}`)
  };
}

// REAL readback cases from experiments/ocr-primitive-proof (native Windows 11,
// Windows.Media.Ocr). Canonical render = render-surface.ps1 default
// $TimeText = "00:00:12.34" (Consolas Bold). "" models a dropped line.
export const REAL_READBACK_CASES = [
  { fontSizePt: 32, canonicalObservedText: '00:00:12.34', rawOcrText: 'ee : ee:12.34', expect: { corroborationConfidence: 1, fractionalTailMatched: true } },
  { fontSizePt: 40, canonicalObservedText: '00:00:12.34', rawOcrText: '', expect: { corroborationConfidence: 0, fractionalTailMatched: false } },
  { fontSizePt: 48, canonicalObservedText: '00:00:12.34', rawOcrText: '', expect: { corroborationConfidence: 0, fractionalTailMatched: false } },
  { fontSizePt: 64, canonicalObservedText: '00:00:12.34', rawOcrText: '', expect: { corroborationConfidence: 0, fractionalTailMatched: false } }
];

// Standalone runner: node experiments/corroboration-confidence-reference.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0;
  for (const c of REAL_READBACK_CASES) {
    const got = corroborationConfidence(c.canonicalObservedText, c.rawOcrText);
    const ok = got.corroborationConfidence === c.expect.corroborationConfidence && got.fractionalTailMatched === c.expect.fractionalTailMatched;
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${c.fontSizePt}pt  raw=${JSON.stringify(c.rawOcrText)}  -> confidence=${got.corroborationConfidence} tailMatched=${got.fractionalTailMatched}\n`);
  }
  process.stdout.write(`\n${REAL_READBACK_CASES.length - failed}/${REAL_READBACK_CASES.length} corroborationConfidence cases passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
