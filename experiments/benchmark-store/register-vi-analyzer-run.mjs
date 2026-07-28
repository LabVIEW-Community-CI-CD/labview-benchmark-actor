#!/usr/bin/env node
// MAINTAINER driver (LBA-REQ-015 pre-stage, mirrors register-mprr-run.mjs): summarize a VI Analyzer report and
// register it as a benchmark-store run keyed by a shared benchmarkId, so the LINUX and WIN runs of the SAME
// VI Analyzer config can be cross-plane compared. When WIN sends their real LabVIEWCLI RunVIAnalyzer report,
// registering it on their plane + this on mine -> crossPlaneCompare -> flip LBA-REQ-015 Proven in one command.
//
// Not a CI gate (writes to the store). Run on each plane:
//   REPORT_PATH=<normalized-vi-analyzer-report.json> node experiments/benchmark-store/register-vi-analyzer-run.mjs
//   (default REPORT_PATH = the committed fixture; store root from LBA_BENCHMARK_STORE_ROOT else the big drive;
//    plane auto-detected or LBA_PLANE.)
//
// The report is the NORMALIZED shape { config, vis: [{ viPath, tests: [{ test, result }] }] } (a plane's parser
// emits it from the real LabVIEWCLI ASCII/XML report). The deterministic, order-independent resultHash is the
// cross-plane anchor: two planes analyzing the same VIs + config produce the same resultHash.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { summarizeViAnalyzerReport, viAnalyzerBenchmarkMetrics } from '../vi-analyzer/viAnalyzerResult.mjs';
import { resolveStoreRoot, openStore, registerRun, listRuns, crossPlaneCompare } from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const plane = process.env.LBA_PLANE || (process.platform === 'win32' ? 'WIN' : 'LINUX');
const DEFAULT_BIG_DRIVE = '/run/media/sergio/Data/lba-benchmark-store';
const root = resolveStoreRoot(process.env.LBA_BENCHMARK_STORE_ROOT) || DEFAULT_BIG_DRIVE;
const reportPath = process.env.REPORT_PATH
  || join(repo, 'experiments', 'vi-analyzer', 'fixtures', 'sample-report.json');

// 1. Summarize the VI Analyzer report (deterministic + order-independent resultHash).
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const summary = summarizeViAnalyzerReport(report);
const metrics = viAnalyzerBenchmarkMetrics(summary);

// 2. Shared benchmarkId: both planes must use the SAME config so the runs pair. Derive from the report config
//    (env VIA_BENCHMARK_ID overrides for an explicit shared key).
const configSlug = String(report.config || basename(reportPath))
  .replace(/\.[^.]*$/, '')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .toLowerCase();
const benchmarkId = process.env.VIA_BENCHMARK_ID || `vi-analyzer-${configSlug}`;
const runId = `${benchmarkId}-${plane.toLowerCase()}`;

// 3. Stage the summary (per-VI results + resultHash) on the store BY REFERENCE, then register the run.
const store = openStore(root);
const runDir = join(store.root, plane, runId);
mkdirSync(runDir, { recursive: true });
const reportRef = join(plane, runId, 'vi-analyzer-summary.json');
const reportJson = `${JSON.stringify(summary, null, 2)}\n`;
writeFileSync(join(store.root, reportRef), reportJson);

const rec = registerRun(store, {
  plane,
  runId,
  benchmarkId,
  capturedAt: new Date().toISOString(),
  ringBufferRef: reportRef,
  ringBufferBytes: Buffer.byteLength(reportJson),
  metrics,
});

console.log(`registered ${plane} run '${runId}' for benchmark '${benchmarkId}' at ${store.root}`);
console.log(`  resultHash=${summary.resultHash}`);
console.log(`  metrics=${JSON.stringify(metrics)}`);
console.log(`  reportRef=${rec.ringBufferRef} (${rec.ringBufferBytes} bytes)`);

// 4. If both planes are present, show the cross-plane comparison (resultHash MUST match).
const planes = new Set(listRuns(store).filter((r) => r.benchmarkId === benchmarkId).map((r) => r.plane));
if (planes.has('LINUX') && planes.has('WIN')) {
  const compare = crossPlaneCompare(store, benchmarkId);
  console.log('\ncross-plane compare (LINUX vs WIN):');
  console.log(`  deltas=${JSON.stringify(compare.deltas)}`);
  console.log(`  digests=${JSON.stringify(compare.digests)}`);
} else {
  console.log(`\nawaiting the other plane (${[...planes].join(',')} present) -- run this on the missing plane to compare.`);
}
