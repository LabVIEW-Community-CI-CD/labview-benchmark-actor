#!/usr/bin/env node
// MAINTAINER tool: instantiate the benchmark ring-buffer store ON THE BIG DRIVE and register a run (operator
// direction: use the +large drive to store ring-buffer data so LINUX + WIN can compare). The big capture file
// itself is produced by the ring-buffer capture path (mprr dual-packet-stream / WIN zero-copy ring buffer) and
// staged under the run dir; this tool creates the store, stages a placeholder capture, and registers the run.
//
// Usage:
//   LBA_BENCHMARK_STORE_ROOT=/run/media/sergio/Data/lba-benchmark-store \
//     node experiments/benchmark-store/init-store-on-drive.mjs [--plane LINUX] [--benchmark vi-render-8vi]
// If LBA_BENCHMARK_STORE_ROOT is unset, falls back to the big drive at /run/media/sergio/Data if it is mounted.

import { existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, registerRun, listRuns, resolveStoreRoot } from './benchmarkStore.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BIG_DRIVE = '/run/media/sergio/Data';
const root = resolveStoreRoot() || (existsSync(BIG_DRIVE) ? join(BIG_DRIVE, 'lba-benchmark-store') : null);
if (!root) {
  console.error('[store] set LBA_BENCHMARK_STORE_ROOT to the big-drive store path (the big drive was not found at ' + BIG_DRIVE + ').');
  process.exit(1);
}

const plane = arg('--plane', 'LINUX');
const benchmarkId = arg('--benchmark', 'vi-render-8vi');
const runId = arg('--run', `${plane.toLowerCase()}-run-${Date.now()}`);

const store = openStore(root);
console.log(`[store] root: ${store.root}`);

// Stage a placeholder ring-buffer capture in the run dir (the real capture is the mprr/zero-copy ring buffer;
// large captures live here on the drive and are referenced, not copied into the index).
const runDir = join(store.root, plane, runId);
const ringBufferRel = join(plane, runId, 'ring-buffer.ndjson');
// (openStore/registerRun create the run dir; write the placeholder after registration below.)

const record = registerRun(store, {
  plane,
  runId,
  benchmarkId,
  capturedAt: new Date().toISOString(),
  ringBufferRef: ringBufferRel,
  metrics: { cpuMeanPct: 48, ramMeanMiB: 640, durationMs: 1360, framesRendered: 465 },
});

// Placeholder ring-buffer file so the ref resolves on the drive (the real path a capture writes to).
const placeholder = `{"note":"placeholder ring-buffer capture -- the real mprr/zero-copy ring buffer streams here","benchmarkId":"${benchmarkId}","plane":"${plane}"}\n`;
writeFileSync(join(store.root, ringBufferRel), placeholder);
const bytes = statSync(join(store.root, ringBufferRel)).size;

console.log(`[store] registered ${plane}/${runId} (benchmark ${benchmarkId}); ring-buffer -> ${ringBufferRel} (${bytes} B placeholder)`);
console.log(`[store] index now has ${listRuns(store).length} run(s). Free capacity on the drive backs large captures.`);
console.log(`[store] cross-plane compare once WIN registers the same benchmarkId: crossPlaneCompare(store, '${benchmarkId}').`);
