#!/usr/bin/env node
// Deterministic self-test for the benchmark ring-buffer store (operator direction: big-drive storage +
// cross-plane compare). Dependency-free. Uses a TEMP store root (not the big drive) so it is repeatable
// anywhere; proves register/list/read, the LINUX-vs-WIN cross-plane comparison (metric deltas), and the
// rejection teeth (bad plane, missing benchmarkId, single-plane compare). Writes a re-runnable receipt.
//
// Usage: node experiments/benchmark-store/verify-benchmark-store.mjs [--json]

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STORE_SCHEMA,
  openStore,
  registerRun,
  listRuns,
  readRun,
  crossPlaneCompare,
} from './benchmarkStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail ?? null });
  } catch (e) {
    results.push({ name, pass: false, error: String(e && e.message ? e.message : e) });
  }
}
function assert(c, m) {
  if (!c) {
    throw new Error(m);
  }
}

const root = mkdtempSync(join(tmpdir(), 'lba-bench-store-'));
let sampleCompare = null;
try {
  const store = openStore(root);

  // A LINUX capture and a WIN capture of the SAME benchmark (a render regression between planes). The
  // seriesHash is the deterministic cross-plane anchor (IDENTICAL on both planes); the per-plane screenshot
  // pngSha256 is a visual witness that legitimately differs across OSes (fonts/AA).
  const sharedSeriesHash = '7ad1c75d08244013d339c3f256fd14220a2df7cea56d5be5b38af2d82d68efaa';
  const linuxMetrics = { cpuMeanPct: 48, ramMeanMiB: 640, durationMs: 1360, framesRendered: 465, seriesHash: sharedSeriesHash, pngSha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888' };
  const winMetrics = { cpuMeanPct: 57, ramMeanMiB: 720, durationMs: 1560, framesRendered: 465, seriesHash: sharedSeriesHash, pngSha256: '9999000011112222333344445555666677778888999900001111222233334444' };

  check('register + read a LINUX run (ring buffer referenced, not copied)', () => {
    const rec = registerRun(store, {
      plane: 'LINUX',
      runId: 'linux-run-001',
      benchmarkId: 'vi-render-8vi',
      capturedAt: '2026-07-28T18:00:00.000Z',
      ringBufferRef: 'LINUX/linux-run-001/ring-buffer.ndjson',
      ringBufferBytes: 987654321,
      metrics: linuxMetrics,
    });
    assert(rec.schema === 'labview-benchmark-actor/benchmark-run@v1', 'run schema');
    const back = readRun(store, 'LINUX', 'linux-run-001');
    assert(back.metrics.cpuMeanPct === 48 && back.ringBufferBytes === 987654321, 'run round-trips with the ring-buffer ref');
  });

  check('register a WIN run for the same benchmarkId', () => {
    registerRun(store, {
      plane: 'WIN',
      runId: 'win-run-001',
      benchmarkId: 'vi-render-8vi',
      ringBufferRef: 'WIN/win-run-001/ring-buffer.ndjson',
      metrics: winMetrics,
    });
    const runs = listRuns(store);
    assert(runs.length === 2 && runs.some((r) => r.plane === 'WIN'), 'both planes indexed');
  });

  check('cross-plane compare reports LINUX-vs-WIN metric deltas', () => {
    sampleCompare = crossPlaneCompare(store, 'vi-render-8vi');
    assert(sampleCompare.schema === 'labview-benchmark-actor/cross-plane-compare@v1', 'compare schema');
    assert(sampleCompare.deltas.cpuMeanPct.delta === 9, `cpu delta 57-48=9, got ${sampleCompare.deltas.cpuMeanPct.delta}`);
    assert(sampleCompare.deltas.durationMs.delta === 200, `duration delta 1560-1360=200, got ${sampleCompare.deltas.durationMs.delta}`);
    assert(sampleCompare.deltas.cpuMeanPct.pctOfLinux === 18.8, `cpu pct 9/48=18.8, got ${sampleCompare.deltas.cpuMeanPct.pctOfLinux}`);
  });

  // Digest agreement: the deterministic seriesHash MUST match cross-plane; the screenshot witness may differ.
  check('cross-plane compare reports content-digest agreement (seriesHash match, screenshot witness)', () => {
    const d = sampleCompare.digests;
    assert(d && d.seriesHash && d.seriesHash.match === true, 'seriesHash must match cross-plane (deterministic data)');
    assert(d.pngSha256 && d.pngSha256.match === false, 'differing screenshot witness is surfaced, not deltafied');
    assert(sampleCompare.deltas.seriesHash === undefined, 'string digests are not treated as numeric deltas');
  });

  // Teeth 1: comparing a benchmark present on only one plane must throw.
  check('single-plane benchmark cannot be cross-plane compared (teeth)', () => {
    registerRun(store, { plane: 'LINUX', runId: 'lonely-1', benchmarkId: 'linux-only', metrics: { cpuMeanPct: 10 } });
    let threw = null;
    try {
      crossPlaneCompare(store, 'linux-only');
    } catch (e) {
      threw = e;
    }
    assert(threw && /LINUX and a WIN run/.test(threw.message), 'must require both planes');
  });

  // Teeth 2: an invalid plane / missing benchmarkId is rejected at registration.
  check('invalid plane + missing benchmarkId are rejected (teeth)', () => {
    let a = null;
    try {
      registerRun(store, { plane: 'MAC', runId: 'x', benchmarkId: 'b', metrics: {} });
    } catch (e) {
      a = e;
    }
    assert(a && /LINUX or WIN/.test(a.message), 'bad plane rejected');
    let b = null;
    try {
      registerRun(store, { plane: 'LINUX', runId: 'x', metrics: {} });
    } catch (e) {
      b = e;
    }
    assert(b && /benchmarkId/.test(b.message), 'missing benchmarkId rejected');
  });

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const receipt = {
    schemaVersion: 'labview-benchmark-actor/benchmark-store-receipt-v1',
    storeSchema: STORE_SCHEMA,
    total,
    passed,
    failed: total - passed,
    sampleCompare,
    results,
  };
  writeFileSync(join(here, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

  if (asJson) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`benchmark-store: ${passed}/${total} checks passed`);
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
    }
  }
  process.exitCode = total === passed ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
