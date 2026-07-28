#!/usr/bin/env node
// Benchmark ring-buffer STORE (operator direction: use the big drive to store ring-buffer data so LINUX and
// WIN can compare against each other's benchmark). A capacity-oriented store that persists each plane's raw
// ring-buffer capture (mprr dual-packet-stream / Windows zero-copy ring buffer, ADR-0031/0032) BY REFERENCE
// plus the derived metrics, keyed by a shared benchmarkId so the two planes' runs of the SAME benchmark can be
// compared. Dependency-free ESM; deterministic. The store ROOT is caller/env supplied (the big drive on this
// box, WIN's drive on theirs) so nothing hard-codes a machine path -- see resolveStoreRoot().
//
// Layout under <root>:  <plane>/<runId>/run.json (+ the caller stages the large ring-buffer.* + frames.* there)
//                       store-index.json  (small append-only index of every registered run)
// The small metrics in each run feed the LBA-REQ-010 corpus (ingestCorpusManifest -> concentrate -> compare);
// the large ring-buffer capture stays on the drive, referenced not copied.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STORE_SCHEMA = 'labview-benchmark-actor/benchmark-store@v1';
export const RUN_SCHEMA = 'labview-benchmark-actor/benchmark-run@v1';
const PLANES = new Set(['LINUX', 'WIN']);

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/**
 * Resolve the store root: an explicit arg wins, else env LBA_BENCHMARK_STORE_ROOT, else null (the caller must
 * supply one). Callers on this box point it at the big drive (e.g. /run/media/sergio/Data/lba-benchmark-store);
 * the deterministic self-test points it at a temp dir. No machine path is baked in here.
 */
export function resolveStoreRoot(explicit) {
  return explicit || process.env.LBA_BENCHMARK_STORE_ROOT || null;
}

/** Open (create if needed) a store at root; returns a handle. */
export function openStore(root) {
  assert(root && typeof root === 'string', 'store root required (arg or LBA_BENCHMARK_STORE_ROOT)');
  mkdirSync(root, { recursive: true });
  const indexPath = join(root, 'store-index.json');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `${JSON.stringify({ schema: STORE_SCHEMA, runs: [] }, null, 2)}\n`);
  }
  return { root, indexPath };
}

function readIndex(store) {
  const idx = JSON.parse(readFileSync(store.indexPath, 'utf8'));
  assert(idx.schema === STORE_SCHEMA, 'store index schema mismatch');
  return idx;
}

/**
 * Register a benchmark run in the store. Writes <plane>/<runId>/run.json and appends to the index. The large
 * ring-buffer capture + frames are referenced (ringBufferRef/framesRef, relative to root) -- the caller stages
 * those big files on the drive; the store keeps only metadata + refs. benchmarkId is the shared key both planes
 * use for the SAME benchmark so crossPlaneCompare can pair them.
 */
export function registerRun(store, run) {
  assert(run && PLANES.has(run.plane), `run.plane must be LINUX or WIN, got ${run && run.plane}`);
  assert(typeof run.runId === 'string' && run.runId, 'run.runId required');
  assert(typeof run.benchmarkId === 'string' && run.benchmarkId, 'run.benchmarkId required (shared cross-plane key)');
  assert(run.metrics && typeof run.metrics === 'object', 'run.metrics required');
  const dir = join(store.root, run.plane, run.runId);
  mkdirSync(dir, { recursive: true });
  const record = {
    schema: RUN_SCHEMA,
    benchmarkId: run.benchmarkId,
    plane: run.plane,
    runId: run.runId,
    capturedAt: run.capturedAt ?? null,
    ringBufferRef: run.ringBufferRef ?? null,
    ringBufferBytes: run.ringBufferBytes ?? null,
    framesRef: run.framesRef ?? null,
    metrics: run.metrics,
  };
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  const idx = readIndex(store);
  idx.runs = idx.runs.filter((r) => !(r.plane === run.plane && r.runId === run.runId));
  idx.runs.push({ benchmarkId: run.benchmarkId, plane: run.plane, runId: run.runId, ref: join(run.plane, run.runId, 'run.json') });
  idx.runs.sort((a, b) => a.benchmarkId.localeCompare(b.benchmarkId) || a.plane.localeCompare(b.plane) || a.runId.localeCompare(b.runId));
  writeFileSync(store.indexPath, `${JSON.stringify(idx, null, 2)}\n`);
  return record;
}

/** List every registered run (index entries). */
export function listRuns(store) {
  return readIndex(store).runs;
}

/** Read a run's full record. */
export function readRun(store, plane, runId) {
  return JSON.parse(readFileSync(join(store.root, plane, runId, 'run.json'), 'utf8'));
}

/**
 * Compare two runs' metrics (baseline LINUX vs candidate WIN) of the same benchmarkId: numeric `deltas` +
 * string `digests` (the deterministic seriesHash MUST match cross-plane; the per-plane screenshot pngSha256 is
 * a witness). Pure + deterministic -- works on two loose run records (e.g. WIN sends its run.json), not only a
 * store, so the next agent can repeat the comparison anywhere.
 */
export function compareRuns(benchmarkId, linuxMetrics, winMetrics) {
  assert(typeof benchmarkId === 'string' && benchmarkId, 'benchmarkId required');
  const l = linuxMetrics || {};
  const w = winMetrics || {};
  const keys = [...new Set([...Object.keys(l), ...Object.keys(w)])];
  const deltas = {};
  const digests = {};
  for (const k of keys) {
    if (typeof l[k] === 'number' && typeof w[k] === 'number') {
      deltas[k] = { linux: l[k], win: w[k], delta: w[k] - l[k], pctOfLinux: l[k] ? +(((w[k] - l[k]) / l[k]) * 100).toFixed(1) : null };
    } else if (typeof l[k] === 'string' && typeof w[k] === 'string') {
      // String metrics are content digests (e.g. seriesHash MUST match cross-plane; the per-plane screenshot
      // pngSha256 is a visual witness that may differ across OSes). Report agreement, not a numeric delta.
      digests[k] = { linux: l[k], win: w[k], match: l[k] === w[k] };
    }
  }
  return { schema: 'labview-benchmark-actor/cross-plane-compare@v1', benchmarkId, linux: l, win: w, deltas, digests };
}

/**
 * Cross-plane compare: pair the LINUX run and the WIN run of the same benchmarkId and report the metric deltas
 * (candidate WIN vs baseline LINUX). This is the "compare against the Windows benchmark" core -- deterministic,
 * so the next agent can repeat it. Throws if the benchmark is not present on both planes.
 */
export function crossPlaneCompare(store, benchmarkId) {
  const idx = readIndex(store);
  const entries = idx.runs.filter((r) => r.benchmarkId === benchmarkId);
  const linux = entries.find((r) => r.plane === 'LINUX');
  const win = entries.find((r) => r.plane === 'WIN');
  assert(linux && win, `benchmark ${benchmarkId} needs a LINUX and a WIN run to compare (have ${entries.map((e) => e.plane).join(',') || 'none'})`);
  return compareRuns(benchmarkId, readRun(store, 'LINUX', linux.runId).metrics, readRun(store, 'WIN', win.runId).metrics);
}
