// Self-test for frame-diff.mjs (cross-iteration visual-delta of two sealed records).
// Dependency-free: builds synthetic manual-procedure-record-v1 records whose perceptualFingerprints come
// from the shared fingerprint.mjs, then checks the pairing + verdict semantics. Exits 0 on pass, 1 on fail.
//   node experiments/manual-procedure-record/frame-diff.selftest.mjs

import { frameDiff } from './frame-diff.mjs';
import { dhash64FromRgba, FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from './fingerprint.mjs';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`PASS  ${name}`); } else { console.error(`FAIL  ${name}`); failures += 1; }
}

const W = 120, H = 90;
function fp(seed) {
  // distinct structured RGBA per seed -> distinct dhash-64
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = 80 + ((x * (100 + seed) + y * (37 + seed)) % 96);
      const p = (y * W + x) * 4;
      rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v; rgba[p + 3] = 255;
    }
  }
  return dhash64FromRgba(rgba, W, H);
}

const FAKE_HASH = 'a'.repeat(64);
let idx = 0;
function frame(caseId, counter, hex, settled = false) {
  return { index: idx++, counter, caseId, settled, perceptualFingerprint: hex, integrityHash: FAKE_HASH };
}
function record(iteration, frames) {
  return {
    schema: 'labview-benchmark-actor/manual-procedure-record-v1',
    iteration,
    fingerprintAlgo: FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    frames,
  };
}

// Settled fingerprints for three cases (the UI state after each completes).
const s00 = fp(0), s01 = fp(1), s02 = fp(2), s01changed = fp(99), s03 = fp(3);

// v1: 3 cases, each with a couple of non-settled frames + one settled (last).
const v1 = record('v1', [
  frame('TC-00', 10, fp(50)), frame('TC-00', 12, s00, true),
  frame('TC-01', 20, fp(51)), frame('TC-01', 23, s01, true),
  frame('TC-02', 30, fp(52)), frame('TC-02', 34, s02, true),
]);

// v2 identical (same settled fingerprints; even if intra-case frames differ in count).
idx = 0;
const v2identical = record('v2', [
  frame('TC-00', 8, fp(60)), frame('TC-00', 9, fp(61)), frame('TC-00', 15, s00, true),
  frame('TC-01', 25, s01, true),
  frame('TC-02', 40, fp(62)), frame('TC-02', 44, s02, true),
]);

// v2 with TC-01 visually changed.
idx = 0;
const v2changed = record('v2', [
  frame('TC-00', 11, s00, true),
  frame('TC-01', 21, s01changed, true),
  frame('TC-02', 31, s02, true),
]);

// v2 with an extra case TC-03 (structural add).
idx = 0;
const v2extra = record('v2', [
  frame('TC-00', 11, s00, true),
  frame('TC-01', 21, s01, true),
  frame('TC-02', 31, s02, true),
  frame('TC-03', 41, s03, true),
]);

const dIdentical = frameDiff(v1, v2identical);
check('identical settled states -> IDENTICAL_WITHIN_THRESHOLD', dIdentical.verdict === 'IDENTICAL_WITHIN_THRESHOLD');
check('identical -> maxHamming 0', dIdentical.maxHamming === 0);
check('identical -> 3 cases compared', dIdentical.casesCompared === 3);
check('robust to human pace (different intra-case frame counts still match by settled)', dIdentical.changedCases.length === 0);

const dChanged = frameDiff(v1, v2changed);
check('changed TC-01 -> VISUAL_DELTA', dChanged.verdict === 'VISUAL_DELTA');
check('changed TC-01 is flagged in changedCases', dChanged.changedCases.includes('TC-01'));
check('unchanged cases not flagged (TC-00, TC-02)', !dChanged.changedCases.includes('TC-00') && !dChanged.changedCases.includes('TC-02'));
check('changed -> maxHamming > threshold', dChanged.maxHamming > 10);

const dExtra = frameDiff(v1, v2extra);
check('added case -> VISUAL_DELTA (structural)', dExtra.verdict === 'VISUAL_DELTA');
check('added TC-03 reported as only-in-B', dExtra.structuralCases.some((c) => c.caseId === 'TC-03' && c.status === 'only-in-B'));

check('fingerprintAlgo mismatch throws', (() => {
  const bad = record('v2', [frame('TC-00', 1, s00, true)]);
  bad.fingerprintAlgo = 'phash-dct-64';
  try { frameDiff(v1, bad); return false; } catch { return true; }
})());

if (failures > 0) { console.error(`\nframe-diff.selftest: ${failures} FAILED`); process.exit(1); }
console.log('\nframe-diff.selftest: all checks passed (caseId pairing + settled-frame diff + verdict).');
