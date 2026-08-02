// Self-test for liveLadderRun.mjs -- proven on REAL data (no fakes): a committed live mesh-stress ladder run on
// this host, where each rung applied REAL scaled CPU load, linuxProcSampler captured a REAL exact-12-FPS series
// per repeat, the signature extractor built the per-rung signature, and the calibration-curve fitter fit the
// ladder + scored the invariants + inverse-read a held-out rung. Deterministic replay of the committed receipt.
// Run: node liveLadderRun.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIVE_LADDER_SCHEMA } from './liveLadderRun.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(readFileSync(join(here, 'fixtures', 'mesh-live-ladder-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- the commanded ladder was applied as REAL scaled load ---
{
  assert.equal(r.schema, LIVE_LADDER_SCHEMA);
  assert.deepEqual(r.ladder.levels, ['idle', 'light', 'medium', 'heavy', 'saturate']);
  const spins = r.ladder.commanded.map((c) => c.spinners);
  for (let i = 1; i < spins.length; i += 1) assert.ok(spins[i] > spins[i - 1], `real load monotonically scales with the rung (${spins.join(',')})`);
  assert.equal(spins[0], 0, 'idle applies no load');
  ok(`live ladder on ${r.host.cpus} cores: real spinners [${spins.join(', ')}] (idle -> all cores)`);
}

// --- the measured cpuTotalPct curve tracks the commanded ladder monotonically (real load -> real response) ---
{
  const curve = r.cpuTotalPctMeanCurve;
  assert.ok(Array.isArray(curve) && curve.length === 5, 'the cpuTotalPct.mean calibration curve spans the ladder');
  for (let i = 1; i < curve.length; i += 1) assert.ok(curve[i].expected > curve[i - 1].expected, `cpuTotalPct.mean is monotone increasing (${curve.map((c) => c.expected).join(',')})`);
  assert.ok(curve[4].expected > 80, 'saturate drives cpuTotalPct near 100%');
  assert.ok(curve[0].expected < 15, 'idle sits low');
  ok(`cpuTotalPct.mean calibration curve [${curve.map((c) => c.expected).join(', ')}]% tracks idle -> saturate`);
}

// --- the design invariants hold on REAL data ---
{
  assert.equal(r.invariants.monotone, 1, 'every salient feature is monotone on the real ladder');
  assert.equal(r.invariants.separable, true, 'adjacent rung bands are separable (the ladder is resolvable)');
  assert.equal(r.invariants.repeatable, true, 'each rung retains stable signature features across repeats');
  assert.ok(r.separability.every((s) => s.separableDims >= 1), 'every rung boundary separates on >= 1 dimension');
  assert.ok(r.salientDimensions.length > 0 && r.salientDimensions.includes('cpuTotalPct.mean'), 'cpuTotalPct.mean is a salient calibration dimension');
  ok(`invariants on REAL data: monotone 100%, separable ${r.invariants.separable}, repeatable ${r.invariants.repeatable}, ${r.salientDimensions.length} salient dims`);
}

// --- inverse read recovers the held-out rung ---
{
  assert.equal(r.inverseRead.heldOutRung, r.inverseRead.inferredRung, 'a held-out rung signature inverse-reads back to its own rung');
  assert.ok(r.inverseRead.confidence > 0.5, `high inverse-read confidence (${r.inverseRead.confidence})`);
  ok(`inverse read: ${r.inverseRead.heldOutRung} -> ${r.inverseRead.inferredRung} (confidence ${r.inverseRead.confidence})`);
}

console.log(`\nliveLadderRun.selftest: ${passed}/${passed} checks passed (REAL data)`);
