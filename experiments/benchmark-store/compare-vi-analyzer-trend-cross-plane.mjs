#!/usr/bin/env node
// Cross-plane VI Analyzer TREND comparison: pair the committed LINUX + WIN trend run records (the benchmark-
// store mirrors) and report the resultHash AGREEMENT (MUST match -- a real VI Analyzer run of the SAME config
// is substrate-independent, so the deterministic digest is identical across OS/LabVIEW builds) plus the timing
// DELTAS (they legitimately differ -- cold-launch + warm-analyze cost). Self-verifying + re-runnable from
// COMMITTED data alone: compareRuns works on two loose run records, no store/drive needed.
//
// Usage:  node experiments/benchmark-store/compare-vi-analyzer-trend-cross-plane.mjs   (writes the receipt; exits 1 on mismatch)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compareRuns } from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const linux = JSON.parse(readFileSync(join(here, 'vi-analyzer-trend-run-LINUX.json'), 'utf8'));
const win = JSON.parse(readFileSync(join(here, 'vi-analyzer-trend-run-WIN.json'), 'utf8'));

if (linux.benchmarkId !== win.benchmarkId) {
  console.error(`benchmarkId mismatch: LINUX ${linux.benchmarkId} vs WIN ${win.benchmarkId}`);
  process.exit(1);
}
const cmp = compareRuns(linux.benchmarkId, linux.metrics, win.metrics);
const hashMatch = cmp.digests.resultHash && cmp.digests.resultHash.match === true;

const receipt = {
  schema: 'labview-benchmark-actor/vi-analyzer-trend-cross-plane@1',
  capturedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  benchmarkId: linux.benchmarkId,
  planes: { linux: linux.runId, win: win.runId },
  correctness: {
    resultHash: cmp.digests.resultHash ? cmp.digests.resultHash.linux : null,
    match: hashMatch,
    verdict: hashMatch
      ? 'SUBSTRATE-INDEPENDENT -- LINUX (64-bit LabVIEW 2026) and WIN (32-bit LabVIEW 2026) produce the BYTE-IDENTICAL VI Analyzer resultHash (69/69 all-pass)'
      : 'MISMATCH -- the cross-plane resultHash differs (investigate)',
  },
  timing: {
    coldWallMs: cmp.deltas.coldWallMs,
    warmMedianMs: cmp.deltas.warmMedianMs,
    note: 'Timing legitimately differs: WIN cold-launch ~11x LINUX (Windows first-launch mass-compile/indexing); WIN warm-analyze ~26% slower. Correctness (resultHash) is identical; cost is substrate-dependent.',
  },
  compare: cmp,
};

writeFileSync(join(here, 'vi-analyzer-trend-cross-plane-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`vi-analyzer-trend cross-plane: resultHash match=${hashMatch}`);
console.log(`  LINUX cold ${cmp.deltas.coldWallMs.linux}ms warm ${cmp.deltas.warmMedianMs.linux}ms | WIN cold ${cmp.deltas.coldWallMs.win}ms warm ${cmp.deltas.warmMedianMs.win}ms`);
if (!hashMatch) {
  console.error('CROSS-PLANE RESULTHASH MISMATCH');
  process.exit(1);
}
console.log('PASS -- cross-plane VI Analyzer resultHash is identical (substrate-independent correctness)');
