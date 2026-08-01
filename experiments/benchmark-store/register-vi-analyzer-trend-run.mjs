#!/usr/bin/env node
// MAINTAINER driver: register the LINUX VI Analyzer TREND (experiments/vi-analyzer/vi-analyzer-trend-live-
// evidence.json) as a benchmark-store run, so a future WIN VI Analyzer trend of the SAME config pairs with it
// cross-plane. On top of the deterministic resultHash (a STRING metric -> the cross-plane digest anchor, which
// MUST match), the trend contributes TIMING metrics (cold-launch vs warm resident-analyze wall, NUMERIC ->
// cross-plane deltas). Mirrors register-vi-analyzer-run.mjs but keyed by a distinct '-trend' benchmarkId so it
// does not collide with the single-run registration.
//
// Not a CI gate (writes to the store). Run:
//   node experiments/benchmark-store/register-vi-analyzer-trend-run.mjs
//   (store root from LBA_BENCHMARK_STORE_ROOT else the big drive; plane auto-detected or LBA_PLANE; also emits
//    a committed representative run record next to this script for version-controlled evidence.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveStoreRoot, openStore, registerRun, listRuns, crossPlaneCompare } from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const plane = process.env.LBA_PLANE || (process.platform === 'win32' ? 'WIN' : 'LINUX');
const DEFAULT_BIG_DRIVE = '/run/media/sergio/Data/lba-benchmark-store';
const root = resolveStoreRoot(process.env.LBA_BENCHMARK_STORE_ROOT) || DEFAULT_BIG_DRIVE;
const receiptPath = process.env.TREND_RECEIPT
  || join(repo, 'experiments', 'vi-analyzer', 'vi-analyzer-trend-live-evidence.json');

// 1. Load the verified trend receipt and project it to benchmark-store metrics.
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const r0 = receipt.runs[0];
const metrics = {
  // Correctness anchor: the resultHash (STRING -> digest, MUST match cross-plane) + the numeric counts.
  totalTests: r0.totalTests,
  passedTests: r0.summary.passed,
  failedTests: r0.summary.failed,
  errorTests: r0.summary.error,
  pass: receipt.gate.verdict.startsWith('PASS') ? 1 : 0,
  resultHash: receipt.determinism.resultHash,
  // Determinism across the trend: distinctResultHashes === 1 means every run produced the SAME digest.
  runs: receipt.runs.length,
  distinctResultHashes: receipt.determinism.distinctResultHashes,
  // Timing trend (NUMERIC -> cross-plane deltas): cold LabVIEW launch vs warm resident-analyze wall.
  coldWallMs: receipt.trend.coldWallMs,
  warmMedianMs: receipt.trend.warmMedianMs,
  warmMinMs: receipt.trend.warmMinMs,
  warmMaxMs: receipt.trend.warmMaxMs,
};

// 2. A DISTINCT '-trend' benchmarkId so the trend does not overwrite the single-run registration and pairs with
//    the WIN trend specifically.
const benchmarkId = process.env.VIA_BENCHMARK_ID || 'vi-analyzer-labviewcliexampleproject-trend';
const runId = `${benchmarkId}-${plane.toLowerCase()}`;

// 3. Stage the receipt on the store BY REFERENCE, then register the run.
const store = openStore(root);
mkdirSync(join(store.root, plane, runId), { recursive: true });
const receiptRef = join(plane, runId, 'vi-analyzer-trend.json');
const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
writeFileSync(join(store.root, receiptRef), receiptJson);

const rec = registerRun(store, {
  plane,
  runId,
  benchmarkId,
  capturedAt: receipt.capturedAt || new Date().toISOString(),
  ringBufferRef: receiptRef,
  ringBufferBytes: Buffer.byteLength(receiptJson),
  metrics,
});

// 4. Emit a committed representative record next to this script (version-controlled proof of the registration).
const mirrorPath = join(here, `vi-analyzer-trend-run-${plane}.json`);
writeFileSync(mirrorPath, `${JSON.stringify(rec, null, 2)}\n`);

console.log(`registered ${plane} run '${runId}' for benchmark '${benchmarkId}' at ${store.root}`);
console.log(`  resultHash=${metrics.resultHash}`);
console.log(`  timing: cold=${metrics.coldWallMs}ms warmMedian=${metrics.warmMedianMs}ms over ${metrics.runs} runs`);
console.log(`  committed mirror: ${mirrorPath}`);

// 5. If both planes are present, show the cross-plane comparison (resultHash MUST match; timings are deltas).
const planes = new Set(listRuns(store).filter((x) => x.benchmarkId === benchmarkId).map((x) => x.plane));
if (planes.has('LINUX') && planes.has('WIN')) {
  const compare = crossPlaneCompare(store, benchmarkId);
  console.log('\ncross-plane compare (LINUX vs WIN):');
  console.log(`  deltas=${JSON.stringify(compare.deltas)}`);
  console.log(`  digests=${JSON.stringify(compare.digests)}`);
} else {
  console.log(`\nawaiting the other plane (${[...planes].join(',')} present) -- register the WIN trend to compare.`);
}
