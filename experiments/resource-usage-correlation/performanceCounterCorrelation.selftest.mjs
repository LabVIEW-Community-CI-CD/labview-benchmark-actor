// Self-test for performanceCounterCorrelation.mjs -- proven on REAL data (no fakes): the exact-12-FPS Linux
// /proc capture + the committed real LINUX & WIN launch fixtures. Deterministic replay of committed real
// captures. Run: node performanceCounterCorrelation.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPerformanceCounterCorrelation, countersOf } from './performanceCounterCorrelation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rj = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const originOf = (fx) => (Number.isFinite(fx.epochMsAtFrameZero) ? fx.epochMsAtFrameZero : fx.samples[0].epochMs);
const triggerOf = (fx) => (Number.isFinite(fx.triggerEpochMs) ? fx.triggerEpochMs : fx.samples[Math.floor(fx.samples.length / 2)].epochMs);
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- REAL exact-12-FPS Linux /proc capture ---
{
  const cap = rj('fixtures/linux-proc-12fps-capture.json');
  assert.equal(cap.measured.exactly12fps, true, 'the committed Linux capture must be EXACTLY 12 FPS');
  assert.ok(Math.abs(cap.frameIntervalMs - 1000 / 12) < 1e-6, 'frame interval is exactly 1000/12 ms');
  const m = buildPerformanceCounterCorrelation({
    frameRateHz: 12, epochMsAtFrameZero: cap.epochMsAtFrameZero, triggerEpochMs: triggerOf(cap), samples: cap.samples
  });
  assert.equal(m.sampleCount, cap.samples.length);
  assert.equal(m.preSampleCount + m.postSampleCount, m.sampleCount);
  assert.ok(m.counterKeys.length >= 12, `full Linux counter set (${m.counterKeys.length})`);
  for (const k of ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec', 'contextSwitchesPerSec']) {
    assert.ok(m.counterKeys.includes(k), `real capture has ${k}`);
    assert.ok(m.perCounter[k].pre.count > 0 && m.perCounter[k].post.count > 0, `${k} windows populated`);
  }
  ok(`real EXACT-12-FPS Linux capture -> v2 engine (${m.counterKeys.length} counters, ${m.sampleCount} samples, 1:1 frames)`);
}

// --- REAL LINUX launch fixture (3 legacy counters) -> backward-compat adaptation ---
{
  const fx = rj('../mprr-capture-ring/fixtures/labview-launch-resource-correlation.json');
  const m = buildPerformanceCounterCorrelation({ frameRateHz: fx.frameRateHz, epochMsAtFrameZero: originOf(fx), triggerEpochMs: triggerOf(fx), samples: fx.samples });
  for (const k of ['cpuTotalPct', 'ramProcessWorkingSetMb', 'diskTotalPct']) {
    assert.ok(m.counterKeys.includes(k), `legacy flat field mapped -> ${k}`);
  }
  assert.equal(m.sampleCount, fx.samples.length);
  assert.ok(Number.isFinite(m.perCounter.ramProcessWorkingSetMb.deltaMean), 'real RAM pre/post delta computed');
  ok(`real LINUX launch fixture (3 legacy counters) -> mapped + correlated (${m.sampleCount} samples)`);
}

// --- REAL WIN launch fixture (cross-plane) ---
{
  const fx = rj('../mprr-capture-ring/fixtures/labview-launch-resource-correlation-win.json');
  const m = buildPerformanceCounterCorrelation({ frameRateHz: fx.frameRateHz, epochMsAtFrameZero: originOf(fx), triggerEpochMs: triggerOf(fx), samples: fx.samples });
  assert.equal(m.sampleCount, fx.samples.length);
  assert.ok(m.counterKeys.includes('cpuTotalPct'), 'WIN plane correlated on the same catalog keys');
  ok(`real WIN launch fixture (cross-plane) -> correlated (${m.sampleCount} samples)`);
}

// --- countersOf legacy adaptation + guards ---
{
  assert.deepEqual(countersOf({ cpuPct: 5, ramMb: 100, diskPct: 2 }), { cpuTotalPct: 5, ramProcessWorkingSetMb: 100, diskTotalPct: 2 });
  assert.deepEqual(countersOf({ counters: { x: 1 } }), { x: 1 });
  assert.throws(() => buildPerformanceCounterCorrelation({ epochMsAtFrameZero: 0, triggerEpochMs: 0, samples: [] }));
  assert.throws(() => buildPerformanceCounterCorrelation({ epochMsAtFrameZero: NaN, triggerEpochMs: 0, samples: [{ epochMs: 1 }] }));
  ok('countersOf legacy adaptation + empty/NaN guards throw');
}

console.log(`\nperformanceCounterCorrelation.selftest: ${passed}/${passed} checks passed (REAL data)`);
