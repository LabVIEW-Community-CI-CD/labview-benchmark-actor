// verify-producer.mjs — end-to-end proof of the manual-procedure-record producer.
//
// Produces REAL manual-procedure-record-v1 records with correlate-seal.mjs (my reader + WIN's
// fingerprint), validates them against the schema's contract, then feeds two iterations through
// WIN's frame-diff.mjs — the true cross-plane E2E: my producer's records + WIN's diff must jointly
// detect an injected visual delta on one case and pass the unchanged cases. Also proves determinism:
// a session whose on-screen counter does not correlate is REFUSED (not sealed). Writes a receipt.
//
//   node verify-producer.mjs   # exits 0 iff every check passes

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderCounter } from './known-digit-reader.mjs';
import { correlateAndSeal } from './correlate-seal.mjs';
import { frameDiff } from './frame-diff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const W = 32;
const H = 32;
const CASES = ['TC-00', 'TC-01', 'TC-02'];

// Two clearly-different deterministic grayscale textures (swapped gradient coefficients) so the
// dhash-64 fingerprint of 'changed' differs from 'base' well above the diff threshold.
function makeRgba(kind) {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = kind === 'changed' ? (x * 31 + y * 151) % 256 : (x * 151 + y * 31) % 256;
      const p = (y * W + x) * 4;
      rgba[p] = v;
      rgba[p + 1] = v;
      rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

function makeSession(iteration, changedCases) {
  const frames = [];
  let counter = 1000;
  for (const cid of CASES) {
    const rgba = makeRgba(changedCases.has(cid) ? 'changed' : 'base');
    for (let k = 0; k < 3; k++) {
      counter += 1; // different intra-case frame counts across sessions are fine (pair by settled)
      frames.push({
        counterBitmap: renderCounter(counter, 6),
        rgba,
        width: W,
        height: H,
        caseId: cid,
        expectedCounter: counter,
        settled: k === 2,
      });
    }
  }
  return {
    iteration,
    sessionId: `sess-${iteration}`,
    procedure: { id: 'reviewer-manual-test-plan', cases: CASES },
    sealedAt: '2026-07-30T00:00:00Z',
    frames,
  };
}

const checks = [];
const check = (name, cond) => checks.push({ name, pass: !!cond });

// --- produce two iterations: v2 changes TC-01 only ---------------------------------------------------
const v1 = correlateAndSeal(makeSession('v1', new Set()));
const v2 = correlateAndSeal(makeSession('v2', new Set(['TC-01'])));

// --- validate the sealed record's contract -----------------------------------------------------------
check('schema id', v1.schema === 'labview-benchmark-actor/manual-procedure-record-v1');
check('record-level fingerprintAlgo dhash-64', v1.fingerprintAlgo === 'dhash-64');
check('fingerprintSpecVersion is integer', Number.isInteger(v1.fingerprintSpecVersion));
check('correlation matched, 0 mismatches', v1.anchor.correlation.matched === true && v1.anchor.correlation.mismatches === 0);
check('seal.rawDiscarded true', v1.seal.rawDiscarded === true);
check('frameCount matches', v1.seal.frameCount === v1.frames.length && v1.frames.length === CASES.length * 3);
check('every frame has caseId + 16-hex fingerprint + 64-hex integrityHash', v1.frames.every((f) => /^[0-9a-f]{16}$/.test(f.perceptualFingerprint) && /^[0-9a-f]{64}$/.test(f.integrityHash) && typeof f.caseId === 'string'));
check('NO raw pixels retained in any frame', v1.frames.every((f) => !('rgba' in f) && !('raw' in f) && !('pixels' in f)));
check('recordHash is 64-hex', /^[0-9a-f]{64}$/.test(v1.seal.recordHash));

// --- E2E through WIN's frame-diff --------------------------------------------------------------------
const same = frameDiff(v1, v1);
check('self-diff -> IDENTICAL_WITHIN_THRESHOLD', same.verdict === 'IDENTICAL_WITHIN_THRESHOLD');

const diff = frameDiff(v1, v2);
check('v1 vs v2 -> VISUAL_DELTA', diff.verdict === 'VISUAL_DELTA');
check('changed case is exactly TC-01', diff.changedCases.length === 1 && diff.changedCases[0] === 'TC-01');
check('TC-00 + TC-02 unchanged', !diff.changedCases.includes('TC-00') && !diff.changedCases.includes('TC-02'));
check('changed-case Hamming clears threshold', diff.maxHamming > diff.threshold);

// --- determinism: a non-correlating session is REFUSED ----------------------------------------------
let refused = false;
try {
  const bad = makeSession('bad', new Set());
  bad.frames[4].expectedCounter += 7; // on-screen counter no longer matches the emitted value
  correlateAndSeal(bad);
} catch {
  refused = true;
}
check('non-correlating session is NOT sealed (throws)', refused);

const passed = checks.filter((c) => c.pass).length;
const verdict = passed === checks.length ? 'PASS' : 'FAIL';
const receipt = {
  schema: 'labview-benchmark-actor/manual-procedure-producer-receipt-v1',
  ranAt: new Date().toISOString(),
  total: checks.length,
  passed,
  failed: checks.length - passed,
  frameDiff: { self: same.verdict, cross: diff.verdict, changedCases: diff.changedCases, maxHamming: diff.maxHamming, threshold: diff.threshold },
  failures: checks.filter((c) => !c.pass).map((c) => c.name),
  verdict,
};
writeFileSync(join(here, 'producer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
console.log(`\nproducer E2E: ${passed}/${checks.length}; self=${same.verdict} cross=${diff.verdict} changed=${JSON.stringify(diff.changedCases)} maxHamming=${diff.maxHamming}; verdict=${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
