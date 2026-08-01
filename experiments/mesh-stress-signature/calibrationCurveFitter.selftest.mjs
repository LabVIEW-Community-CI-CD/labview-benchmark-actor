// Self-test for calibrationCurveFitter.mjs -- a synthetic stress LADDER (idle -> saturate) with a counter that
// tracks the rung (salient, monotone, separable) + a flat noisy counter (not salient); asserts the fitted curve,
// the design invariants, and the INVERSE READ (observed signature -> inferred rung). Deterministic.
// Run: node calibrationCurveFitter.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { buildSignature } from './signatureExtractor.mjs';
import { fitCalibrationCurve, inverseRead, MESH_CALIBRATION_SCHEMA } from './calibrationCurveFitter.mjs';

let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const DT = 1000 / 12;

// deterministic pseudo-values around a mean (LCG, no deps).
function around(mean, n, jitter, seed) {
  const out = [];
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out.push(mean + ((x / 0x7fffffff) - 0.5) * 2 * jitter);
  }
  return out;
}

// one rung = R repeated runs; cpuTotalPct tracks the rung (tight), noise is flat ~50 but swings across repeats.
function rungSignature(cpuMean, startMs, R = 3) {
  const runs = [];
  for (let r = 0; r < R; r += 1) {
    const cpu = around(cpuMean, 16, 1.2, 100 + r + cpuMean);
    const noise = around([40, 60, 50][r], 16, 6, 200 + r);
    const samples = [];
    for (let i = 0; i < 16; i += 1) {
      samples.push({ epochMs: startMs + r * 100000 + Math.round(i * DT), counters: { cpuTotalPct: cpu[i], noise: noise[i] } });
    }
    runs.push({ samples });
  }
  return buildSignature(runs, { stabilityThreshold: 0.2 });
}

const ladder = [
  { rung: 'idle', level: 0, signature: rungSignature(10, 1_000_000) },
  { rung: 'light', level: 1, signature: rungSignature(30, 2_000_000) },
  { rung: 'medium', level: 2, signature: rungSignature(50, 3_000_000) },
  { rung: 'heavy', level: 3, signature: rungSignature(70, 4_000_000) },
  { rung: 'saturate', level: 4, signature: rungSignature(90, 5_000_000) },
];

// --- fit the calibration curve ---
const model = fitCalibrationCurve(ladder, { bandK: 2, separableMinDims: 1 });
{
  assert.equal(model.schema, MESH_CALIBRATION_SCHEMA);
  assert.equal(model.rungs.length, 5);
  const cpuMean = model.perFeature['cpuTotalPct.mean'];
  assert.ok(cpuMean && cpuMean.salient, 'cpuTotalPct.mean is a salient calibration dimension');
  assert.equal(cpuMean.monotone, 'increasing', 'cpuTotalPct.mean is monotone increasing with the rung');
  assert.deepEqual(cpuMean.curve.map((c) => Math.round(c.expected)), [10, 30, 50, 70, 90], 'the calibration curve tracks the commanded ladder');
  assert.ok(!(model.perFeature['noise.mean'] && model.perFeature['noise.mean'].salient), 'a flat noisy counter is NOT a salient dimension');
  ok(`calibration curve: cpuTotalPct.mean salient+monotone [${model.perFeature['cpuTotalPct.mean'].curve.map((c) => Math.round(c.expected)).join(', ')}]`);
}

// --- design invariants: monotone + separable + repeatable ---
{
  assert.ok(model.invariants.monotone >= 0.9, `salient features are monotone (got ${model.invariants.monotone})`);
  assert.equal(model.invariants.separable, true, 'adjacent rung bands are separable (>=1 dim each boundary)');
  assert.equal(model.invariants.repeatable, true, 'every rung has stable signature features');
  assert.ok(model.separability.every((s) => s.separableDims >= 1), 'each boundary separates on >=1 dimension');
  ok(`invariants: monotone ${(model.invariants.monotone * 100).toFixed(0)}%, separable ${model.invariants.separable}, repeatable ${model.invariants.repeatable}`);
}

// --- inverse read: an observed signature maps back to its rung ---
{
  const atMedium = inverseRead(model, ladder[2].signature);
  assert.equal(atMedium.inferredRung, 'medium', `the medium-rung signature reads back as medium (got ${atMedium.inferredRung})`);
  const atHeavy = inverseRead(model, { perCounter: { cpuTotalPct: { features: { mean: 72, p50: 71, p95: 75, p99: 76, min: 68, max: 78 } } } });
  assert.equal(atHeavy.inferredRung, 'heavy', `an observed cpu ~70 reads back as heavy (got ${atHeavy.inferredRung})`);
  assert.ok(atMedium.confidence > 0.5, `high confidence at an on-curve rung (got ${atMedium.confidence.toFixed(2)})`);
  ok(`inverse read: medium->${atMedium.inferredRung} (conf ${atMedium.confidence.toFixed(2)}), cpu~70->${atHeavy.inferredRung}`);
}

// --- guards ---
{
  assert.throws(() => fitCalibrationCurve([ladder[0]]), 'a single rung throws (need >= 2)');
  assert.throws(() => fitCalibrationCurve([{ rung: 'x', level: 0 }, { rung: 'y', level: 1 }]), 'missing signature throws');
  ok('guards: <2 rungs / missing signature throw');
}

console.log(`\ncalibrationCurveFitter.selftest: ${passed}/${passed} checks passed`);
