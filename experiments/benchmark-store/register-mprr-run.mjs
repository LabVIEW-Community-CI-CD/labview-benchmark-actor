#!/usr/bin/env node
// MAINTAINER driver (operator direction: "use the +2TB drive for storing data from the ring buffer ... to
// compare against windows benchmark"). Ingests the committed mprr short-packet fixture through the absorbed
// ring core, stages the derived ring-buffer capture on the big-drive store BY REFERENCE, and registers a
// benchmark run keyed by a shared benchmarkId so the LINUX and WIN runs of the SAME benchmark can be compared.
//
// Not a CI gate (it writes to the big drive). Run on each plane:
//   node experiments/benchmark-store/register-mprr-run.mjs
//   (Store root defaults to LBA_BENCHMARK_STORE_ROOT, else the big drive; plane auto-detected or LBA_PLANE.)
//
// After BOTH planes have registered, `crossPlaneCompare(store, 'mprr-short-ring-fixture')` reports the numeric
// deltas AND the digest agreement (seriesHash must match; the screenshot pngSha256 is the per-plane witness).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ingestShortPackets } from '../mprr-ring/mprrRing.mjs';
import { projectViewerSeries, seriesHash } from '../mprr-ring/mprrViewerSeries.mjs';
import { resolveStoreRoot, openStore, registerRun, listRuns, crossPlaneCompare } from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const plane = process.env.LBA_PLANE || (process.platform === 'win32' ? 'WIN' : 'LINUX');
const DEFAULT_BIG_DRIVE = '/run/media/sergio/Data/lba-benchmark-store';
const root = resolveStoreRoot(process.env.LBA_BENCHMARK_STORE_ROOT) || DEFAULT_BIG_DRIVE;
const benchmarkId = 'mprr-short-ring-fixture';
const runId = `${benchmarkId}-${plane.toLowerCase()}`;

// 1. Ingest the committed fixture through the absorbed mprr ring core (deterministic).
const fixture = JSON.parse(readFileSync(join(repo, 'experiments', 'mprr-ring', 'fixtures', 'short-packet-run.json'), 'utf8'));
const ingest = ingestShortPackets(fixture.packets, {
  blockDurationTicks: fixture.blockDurationTicks,
  capacityBytes: fixture.capacityBytes,
});
const series = projectViewerSeries(ingest, { metric: 'cumulativeBytes' });
const hash = seriesHash(series);

// 2. Pull the per-plane screenshot witness (pngSha256) from the screenshot receipt if it was produced.
let pngSha256 = null;
const receiptPath = join(repo, 'playwright', `screenshot-receipt-${plane}.json`);
if (existsSync(receiptPath)) {
  const r = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (r.seriesHash && r.seriesHash !== hash) {
    throw new Error(`screenshot receipt seriesHash (${r.seriesHash}) != ingest seriesHash (${hash}) -- stale receipt`);
  }
  pngSha256 = r.pngSha256 || null;
}

// 3. Open the store on the big drive and stage the derived ring-buffer capture BY REFERENCE.
const store = openStore(root);
const runDir = join(store.root, plane, runId);
mkdirSync(runDir, { recursive: true });
const ringBufferRef = join(plane, runId, 'ring-ingest.json');
const ringBufferJson = `${JSON.stringify({ schema: ingest.schema, blocks: ingest.blocks, series: ingest.series }, null, 2)}\n`;
writeFileSync(join(store.root, ringBufferRef), ringBufferJson);

// 4. Register the run. Numeric metrics delta cross-plane; string metrics (seriesHash/pngSha256) are digests.
const metrics = {
  totalBytes: ingest.totalBytes,
  packetCount: ingest.packetCount,
  blockCount: ingest.blockCount,
  worstBoundaryVariationPct: ingest.worstBoundaryVariationPct ?? 0,
  capacityBytes: ingest.capacityBytes,
  ringHeadPublished: ingest.ringState.headPublished,
  authoritative: ingest.authoritative ? 1 : 0,
  seriesHash: hash,
};
if (pngSha256) {
  metrics.pngSha256 = pngSha256;
}

const rec = registerRun(store, {
  plane,
  runId,
  benchmarkId,
  capturedAt: new Date().toISOString(),
  ringBufferRef,
  ringBufferBytes: Buffer.byteLength(ringBufferJson),
  metrics,
});

console.log(`registered ${plane} run '${runId}' for benchmark '${benchmarkId}' at ${store.root}`);
console.log(`  seriesHash=${hash}`);
console.log(`  metrics=${JSON.stringify(metrics)}`);
console.log(`  ringBufferRef=${rec.ringBufferRef} (${rec.ringBufferBytes} bytes)`);

// 5. If both planes are present, show the cross-plane comparison now.
const planes = new Set(listRuns(store).filter((r) => r.benchmarkId === benchmarkId).map((r) => r.plane));
if (planes.has('LINUX') && planes.has('WIN')) {
  const compare = crossPlaneCompare(store, benchmarkId);
  console.log('\ncross-plane compare (LINUX vs WIN):');
  console.log(`  deltas=${JSON.stringify(compare.deltas)}`);
  console.log(`  digests=${JSON.stringify(compare.digests)}`);
} else {
  console.log(`\nawaiting the other plane (${[...planes].join(',')} present) -- run this on the missing plane to compare.`);
}
