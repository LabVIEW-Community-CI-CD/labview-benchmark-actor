// labview-benchmark-actor — corroborationConfidence reference implementation.
//
// Reference for ADR-0007 (image-derived timing binds to the pixel-decoded binary
// strip; the colon-formatted hh:mm:ss.cc time is human-only). The authoritative
// per-sample centiseconds come from the pixel-decoded binary strip (per-cell
// intensity, dark<128 -> 1; NOT OCR of "1010" glyphs); this metric scores how much
// the FRAGILE colon-time OCR readback (rawOcrText) still corroborates the
// fast-changing centisecond digits, recorded beside the sample as auditable
// fidelity evidence (never as the timing source).
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

// SYNTHETIC behavioural contract cases (NOT measured OCR -- kept separate from
// REAL_READBACK_CASES so measured data is never conflated with fixtures). They
// lock the metric's response to the real Windows.Media.Ocr colon-time failure
// modes plane 2 will hit on the actual stopwatch times (10/12/15 cs): colon
// prefix dropped, fractional tail only, transposed digits, whitespace noise, empty.
export const SYNTHETIC_CONTRACT_CASES = [
  { name: 'full-canonical', canonicalObservedText: '00:00:00.10', rawOcrText: '00:00:00.10', expect: { corroborationConfidence: 1, fractionalTailMatched: true } },
  { name: 'colon-dropped', canonicalObservedText: '00:00:00.12', rawOcrText: '00000012', expect: { corroborationConfidence: 1, fractionalTailMatched: false } },
  { name: 'tail-only', canonicalObservedText: '00:00:00.15', rawOcrText: '.15', expect: { corroborationConfidence: 1, fractionalTailMatched: true } },
  { name: 'transposed', canonicalObservedText: '00:00:00.15', rawOcrText: '51', expect: { corroborationConfidence: 0.5, fractionalTailMatched: false } },
  { name: 'noisy-tail', canonicalObservedText: '00:00:00.34', rawOcrText: 'ee : ee:00.34', expect: { corroborationConfidence: 1, fractionalTailMatched: true } },
  { name: 'empty', canonicalObservedText: '00:00:00.10', rawOcrText: '', expect: { corroborationConfidence: 0, fractionalTailMatched: false } }
];

// Plane-2 colonOcr fidelity object contract. Plane 1 (Linux) and plane 3 (native
// Windows) leave image-derived-timing.json fidelity.colonOcr as the placeholder
// STRING below (no OCR run). Plane 2 (golden Win11 VM) REPLACES it with an object
// of this shape, recording a REAL Windows.Media.Ocr read-back scored by
// corroborationConfidence(). The object is non-load-bearing auditable evidence
// only; observedCentiseconds stays strip-anchored (ADR-0007).
export const COLON_OCR_PLACEHOLDER = 'human-only-not-machine-timing';

export const PLANE2_COLON_OCR_CONTRACT = {
  role: COLON_OCR_PLACEHOLDER,        // asserts the OCR stays human-only, not timing
  engine: 'Windows.Media.Ocr',        // the fragile human-display OCR engine
  rawOcrText: '<string>',             // verbatim OCR read-back (may be "", noisy)
  matchedFastDigits: '<0..2>',        // from corroborationConfidence()
  corroborationConfidence: '<0..1>',  // matchedFastDigits / 2
  fractionalTailMatched: '<boolean>'  // rawOcrText ends with "." + centisecond pair
};

// Validate one timing sample's fidelity.colonOcr against this reference.
// - placeholder string (plane 1/3): returns { plane: 'strip-only', placeholder: true }.
// - object (plane 2): recomputes the metric from (canonicalObservedText, rawOcrText)
//   and THROWS if role is wrong, rawOcrText is not a string, or any recorded metric
//   field disagrees with the reference. Returns the recomputed metric on success.
export function validateColonOcrFidelity(colonOcr, canonicalObservedText) {
  if (colonOcr === COLON_OCR_PLACEHOLDER) {
    return { plane: 'strip-only', placeholder: true };
  }
  if (colonOcr === null || typeof colonOcr !== 'object') {
    throw new Error(`fidelity.colonOcr must be the placeholder ${JSON.stringify(COLON_OCR_PLACEHOLDER)} or a plane-2 object, got ${JSON.stringify(colonOcr)}`);
  }
  if (colonOcr.role !== COLON_OCR_PLACEHOLDER) {
    throw new Error(`plane-2 colonOcr.role must be ${JSON.stringify(COLON_OCR_PLACEHOLDER)} (OCR stays human-only), got ${JSON.stringify(colonOcr.role)}`);
  }
  if (typeof colonOcr.rawOcrText !== 'string') {
    throw new Error(`plane-2 colonOcr.rawOcrText must be a string, got ${JSON.stringify(colonOcr.rawOcrText)}`);
  }
  const recomputed = corroborationConfidence(canonicalObservedText, colonOcr.rawOcrText);
  for (const key of ['matchedFastDigits', 'corroborationConfidence', 'fractionalTailMatched']) {
    if (colonOcr[key] !== recomputed[key]) {
      throw new Error(`plane-2 colonOcr.${key} = ${JSON.stringify(colonOcr[key])} disagrees with reference ${JSON.stringify(recomputed[key])} for rawOcrText ${JSON.stringify(colonOcr.rawOcrText)}`);
    }
  }
  return { plane: 'colon-ocr', placeholder: false, ...recomputed };
}

// Standalone runner: node experiments/corroboration-confidence-reference.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0;
  const run = (label, cases) => {
    for (const c of cases) {
      const got = corroborationConfidence(c.canonicalObservedText, c.rawOcrText);
      const ok = got.corroborationConfidence === c.expect.corroborationConfidence && got.fractionalTailMatched === c.expect.fractionalTailMatched;
      if (!ok) failed += 1;
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${c.fontSizePt ? c.fontSizePt + 'pt' : c.name}  raw=${JSON.stringify(c.rawOcrText)}  -> confidence=${got.corroborationConfidence} tailMatched=${got.fractionalTailMatched}\n`);
    }
  };
  run('real ', REAL_READBACK_CASES);
  run('synth', SYNTHETIC_CONTRACT_CASES);

  // validateColonOcrFidelity round-trip: placeholder passes; a well-formed plane-2
  // object passes; a tampered confidence throws.
  const good = corroborationConfidence('00:00:00.34', 'ee : ee:00.34');
  const selfTests = [
    ['placeholder', validateColonOcrFidelity(COLON_OCR_PLACEHOLDER, '00:00:00.10').placeholder === true],
    ['plane2-object', validateColonOcrFidelity({ role: COLON_OCR_PLACEHOLDER, engine: 'Windows.Media.Ocr', rawOcrText: 'ee : ee:00.34', ...good }, '00:00:00.34').corroborationConfidence === 1],
    ['tamper-throws', (() => { try { validateColonOcrFidelity({ role: COLON_OCR_PLACEHOLDER, rawOcrText: 'ee : ee:00.34', ...good, corroborationConfidence: 0 }, '00:00:00.34'); return false; } catch { return true; } })()]
  ];
  for (const [label, ok] of selfTests) {
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  validate  ${label}\n`);
  }

  const total = REAL_READBACK_CASES.length + SYNTHETIC_CONTRACT_CASES.length + selfTests.length;
  process.stdout.write(`\n${total - failed}/${total} corroborationConfidence + validate cases passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
