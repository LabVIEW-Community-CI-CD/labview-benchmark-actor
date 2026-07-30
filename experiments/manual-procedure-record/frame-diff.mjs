// Cross-iteration visual-delta of two SEALED manual-procedure-record-v1 records (the WIN consumer side
// of the deterministic-record seam). Pairs frames by `caseId` and diffs a representative "settled" frame
// per case (robust to human-paced frame counts), using the pinned shared dhash-64 from fingerprint.mjs.
//
// Design (co-designed with LINUX on PR #147): the counter is TIME (intra-session seal anchor) and does NOT
// align across two human-paced sessions, so cross-iteration pairing is by `caseId`. Per case we compare the
// SETTLED frame (the UI state after the case completes = the frame flagged `settled:true`, else the last
// frame of that caseId before the next case). LINUX's seal step computes each `perceptualFingerprint` via the
// shared fingerprint.mjs; this consumer only Hamming-distances the hex.
//
//   import { frameDiff } from './frame-diff.mjs'
//   node experiments/manual-procedure-record/frame-diff.mjs <recordA.json> <recordB.json> [threshold]

import { readFileSync } from 'node:fs';
import { hammingHex, FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from './fingerprint.mjs';

// Record-level algo/spec (Point-2 hoist) with a per-frame fallback (pre-hoist schema tolerance).
function recordAlgo(record) {
  return record.fingerprintAlgo ?? record.frames?.[0]?.fingerprintAlgo ?? null;
}
function recordSpec(record) {
  return record.fingerprintSpecVersion ?? FINGERPRINT_SPEC_VERSION;
}

// The representative "settled" frame for each caseId: prefer an explicit `settled: true`, else the last
// frame of that caseId by counter (the state after the case completes).
function settledFrameByCase(record) {
  const byCase = new Map();
  for (const f of record.frames ?? []) {
    const cid = f.caseId;
    if (cid === undefined || cid === null) continue;
    const cur = byCase.get(cid);
    if (f.settled === true) {
      byCase.set(cid, f);
    } else if (!cur || (cur.settled !== true && f.counter >= cur.counter)) {
      byCase.set(cid, f);
    }
  }
  return byCase;
}

/**
 * Compute the cross-iteration visual delta between two sealed records.
 * @param {object} recordA sealed manual-procedure-record-v1 (iteration A)
 * @param {object} recordB sealed manual-procedure-record-v1 (iteration B)
 * @param {{threshold?:number}} [options] Hamming threshold above which a case is "changed" (default 10)
 * @returns {object} diff report with per-case Hamming, max/mean, changed cases, and a verdict
 */
export function frameDiff(recordA, recordB, options = {}) {
  const threshold = Number.isInteger(options.threshold) ? options.threshold : 10;

  const algoA = recordAlgo(recordA);
  const algoB = recordAlgo(recordB);
  if (algoA !== algoB) {
    throw new Error(`frame-diff: fingerprintAlgo mismatch (${algoA} vs ${algoB}) — records are not comparable`);
  }
  if (algoA !== FINGERPRINT_ALGO) {
    throw new Error(`frame-diff: records use '${algoA}' but this build computes '${FINGERPRINT_ALGO}'`);
  }
  if (recordSpec(recordA) !== recordSpec(recordB)) {
    throw new Error(`frame-diff: fingerprintSpecVersion mismatch (${recordSpec(recordA)} vs ${recordSpec(recordB)})`);
  }

  const A = settledFrameByCase(recordA);
  const B = settledFrameByCase(recordB);
  const caseIds = [...new Set([...A.keys(), ...B.keys()])].sort();

  const perCase = [];
  let maxHamming = 0;
  let sum = 0;
  let compared = 0;
  for (const cid of caseIds) {
    const fa = A.get(cid);
    const fb = B.get(cid);
    if (!fa || !fb) {
      perCase.push({ caseId: cid, status: fa ? 'only-in-A' : 'only-in-B', hamming: null });
      continue;
    }
    const h = hammingHex(fa.perceptualFingerprint, fb.perceptualFingerprint);
    perCase.push({ caseId: cid, status: h > threshold ? 'changed' : 'match', hamming: h });
    maxHamming = Math.max(maxHamming, h);
    sum += h;
    compared += 1;
  }

  const changedCases = perCase.filter((c) => c.status === 'changed').map((c) => c.caseId);
  const structural = perCase.filter((c) => c.status.startsWith('only-')).map((c) => ({ caseId: c.caseId, status: c.status }));
  const verdict =
    changedCases.length === 0 && structural.length === 0 ? 'IDENTICAL_WITHIN_THRESHOLD' : 'VISUAL_DELTA';

  return {
    iterationA: recordA.iteration ?? null,
    iterationB: recordB.iteration ?? null,
    fingerprintAlgo: algoA,
    fingerprintSpecVersion: recordSpec(recordA),
    threshold,
    casesCompared: compared,
    maxHamming,
    meanHamming: compared ? sum / compared : 0,
    changedCases,
    structuralCases: structural,
    perCase,
    verdict,
  };
}

// CLI: node frame-diff.mjs a.json b.json [threshold]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [a, b, t] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: node frame-diff.mjs <recordA.json> <recordB.json> [threshold]');
    process.exit(2);
  }
  const recordA = JSON.parse(readFileSync(a, 'utf8'));
  const recordB = JSON.parse(readFileSync(b, 'utf8'));
  const report = frameDiff(recordA, recordB, { threshold: t ? Number.parseInt(t, 10) : undefined });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'IDENTICAL_WITHIN_THRESHOLD' ? 0 : 1);
}
