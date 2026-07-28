#!/usr/bin/env node
// MAINTAINER cross-plane comparison driver -- the artifact that flips LBA-REQ-014 -> Proven. Given a LINUX
// run.json and a WIN run.json of the SAME benchmarkId (WIN sends theirs over the bus / a synced folder), it
// emits a committed, re-runnable cross-plane comparison receipt: numeric deltas + content-digest agreement.
// The deterministic seriesHash MUST match across planes (the LBA-REQ-014 acceptance); the per-plane screenshot
// pngSha256 is the visual witness. Exit 0 iff the seriesHash matches.
//
// Usage:
//   node experiments/benchmark-store/compare-cross-plane.mjs <linux-run.json> <win-run.json> [--out <path>]
// Each run.json is the record benchmarkStore.registerRun / register-mprr-run.mjs writes
// (<root>/<plane>/<runId>/run.json). Nothing here needs the big drive -- it compares two loose records.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compareRuns } from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : join(here, 'cross-plane-comparison-receipt.json');
const runPaths = args.filter((a, i) => a !== '--out' && !(outIdx >= 0 && i === outIdx + 1));

if (runPaths.length !== 2) {
  console.error('usage: compare-cross-plane.mjs <linux-run.json> <win-run.json> [--out <path>]');
  process.exit(2);
}

const runs = runPaths.map((p) => ({ path: p, rec: JSON.parse(readFileSync(p, 'utf8')) }));
const linux = runs.find((r) => r.rec.plane === 'LINUX');
const win = runs.find((r) => r.rec.plane === 'WIN');
if (!linux || !win) {
  console.error(`need one LINUX run.json and one WIN run.json; got planes: ${runs.map((r) => r.rec.plane).join(', ')}`);
  process.exit(2);
}
if (linux.rec.benchmarkId !== win.rec.benchmarkId) {
  console.error(`benchmarkId mismatch: LINUX=${linux.rec.benchmarkId} WIN=${win.rec.benchmarkId} (must be the same benchmark)`);
  process.exit(2);
}

const benchmarkId = linux.rec.benchmarkId;
const comparison = compareRuns(benchmarkId, linux.rec.metrics, win.rec.metrics);

// Auto-detect the deterministic ANCHOR digest that MUST match cross-plane: seriesHash (mprr, LBA-REQ-014) or
// resultHash (VI Analyzer, LBA-REQ-015). The anchor is the acceptance; other digests (e.g. the screenshot
// pngSha256) are witnesses that may legitimately differ across OSes.
const ANCHORS = [
  { key: 'seriesHash', requirement: 'LBA-REQ-014', label: 'mprr series' },
  { key: 'resultHash', requirement: 'LBA-REQ-015', label: 'VI Analyzer result' },
];
const anchor = ANCHORS.find((a) => comparison.digests[a.key]);
if (!anchor) {
  console.error(`no known anchor digest (seriesHash|resultHash) in the comparison for '${benchmarkId}'`);
  process.exit(2);
}
const anchorDigest = comparison.digests[anchor.key];
const anchorMatch = Boolean(anchorDigest && anchorDigest.match);

const receipt = {
  schema: 'labview-benchmark-actor/cross-plane-comparison-receipt@v1',
  requirement: anchor.requirement,
  benchmarkId,
  producedAt: new Date().toISOString(),
  linuxRunId: linux.rec.runId,
  winRunId: win.rec.runId,
  anchorDigest: anchor.key,
  anchorMatch,
  // Back-compat: LBA-REQ-014 evidence + gate read seriesHashMatch; keep it when the anchor is seriesHash.
  ...(anchor.key === 'seriesHash' ? { seriesHashMatch: anchorMatch } : {}),
  screenshotWitness: comparison.digests.pngSha256
    ? { linux: comparison.digests.pngSha256.linux, win: comparison.digests.pngSha256.win, identical: comparison.digests.pngSha256.match }
    : null,
  comparison,
};
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(`cross-plane comparison for '${benchmarkId}' (LINUX ${linux.rec.runId} vs WIN ${win.rec.runId}):`);
console.log(`  deltas=${JSON.stringify(comparison.deltas)}`);
console.log(`  digests=${JSON.stringify(comparison.digests)}`);
console.log(`  ${anchor.key} match (${anchor.requirement} acceptance): ${anchorMatch ? 'PASS' : 'FAIL'}`);
console.log(`  wrote ${outPath}`);
if (!anchorMatch) {
  console.error(`FAIL -- the deterministic ${anchor.key} does NOT match cross-plane; the ${anchor.label} input diverged.`);
  process.exit(1);
}
console.log(`PASS -- deterministic ${anchor.key} matches cross-plane (${anchor.requirement}).`);
