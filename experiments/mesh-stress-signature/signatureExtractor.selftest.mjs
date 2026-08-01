// Self-test for signatureExtractor.mjs -- synthetic cases exercise each feature deterministically (stability
// signature-vs-noise, MAD outliers, cross-counter co-occurrence, autocorrelation periodicity), and the REAL
// committed exact-12-FPS Linux /proc capture (split into repeats) proves it handles real counter series.
// Run: node signatureExtractor.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSignature, runFeatures, MESH_SIGNATURE_SCHEMA } from './signatureExtractor.mjs';

let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const DT = 1000 / 12;

// build a run { samples } from per-counter value arrays at 12 FPS.
function run(countersByKey, startMs = 1000) {
  const keys = Object.keys(countersByKey);
  const n = countersByKey[keys[0]].length;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const counters = {};
    for (const k of keys) counters[k] = countersByKey[k][i];
    samples.push({ epochMs: Math.round(startMs + i * DT), counters });
  }
  return { samples };
}

// --- stability: a feature stable across repeats is SIGNATURE; one that varies is NOISE ---
{
  const runs = [
    run({ cpu: [50, 50, 51, 49, 50, 50, 50, 50], ram: [100, 100, 100, 100, 100, 100, 100, 100] }),
    run({ cpu: [50, 49, 50, 51, 50, 50, 50, 50], ram: [400, 400, 400, 400, 400, 400, 400, 400] }),
    run({ cpu: [50, 50, 50, 50, 49, 51, 50, 50], ram: [250, 250, 250, 250, 250, 250, 250, 250] }),
  ];
  const sig = buildSignature(runs, { stabilityThreshold: 0.1 });
  assert.equal(sig.schema, MESH_SIGNATURE_SCHEMA);
  assert.equal(sig.repeats, 3);
  assert.ok('cpu.mean' in sig.signatureVector, 'a mean stable across repeats is a signature feature');
  assert.ok(!('ram.mean' in sig.signatureVector), 'a mean that swings across repeats is noise, not signature');
  assert.ok(sig.perCounter.cpu.signatureFeatures.includes('mean'), 'cpu.mean classified signature');
  assert.ok(sig.perCounter.ram.noiseFeatures.includes('mean'), 'ram.mean classified noise');
  ok('across-repeat stability: stable feature -> signature, swinging feature -> noise');
}

// --- MAD outliers + cross-counter co-occurrence within +/-200 ms ---
{
  const r = run({
    a: [5, 5, 5, 5, 5, 5, 5, 80, 5, 5, 5, 5],
    b: [1, 1, 1, 1, 1, 1, 1, 30, 1, 1, 1, 1],
    c: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  });
  const sig = buildSignature([r]);
  const aoi = sig.perCounter.a.outlierEpochsByRun[0];
  assert.ok(aoi.length === 1 && aoi[0] === r.samples[7].epochMs, 'the spike frame is the single MAD outlier');
  assert.equal(sig.perCounter.c.outlierEpochsByRun[0].length, 0, 'a flat counter has no outliers');
  const pair = sig.crossCounter.find((p) => (p.a === 'a' && p.b === 'b') || (p.a === 'b' && p.b === 'a'));
  assert.ok(pair && pair.coOccurrences >= 1, 'counters a & b share a co-occurring outlier (shared-cause signature)');
  assert.ok(!sig.crossCounter.some((p) => p.a === 'c' || p.b === 'c'), 'the flat counter c co-occurs with nothing');
  ok('MAD outliers detected + cross-counter co-occurrence within tolerance');
}

// --- autocorrelation periodicity: an 8-sample-period wave -> dominantPeriodMs ~ 8*83.3 = 667 ms ---
{
  const wave = [];
  for (let i = 0; i < 32; i += 1) wave.push(Math.round(50 + 20 * Math.sin((2 * Math.PI * i) / 8)));
  const f = runFeatures(wave.map((_, i) => Math.round(1000 + i * DT)), wave, { frameRateHz: 12 });
  assert.ok(Math.abs(f.dominantPeriodMs - 667) <= 90, `dominant period ~667 ms, got ${f.dominantPeriodMs}`);
  assert.ok(f.periodicityStrength > 0.4, `periodicity strength high for a clean wave, got ${f.periodicityStrength}`);
  ok(`autocorrelation periodicity: 8-frame wave -> ${f.dominantPeriodMs} ms (strength ${f.periodicityStrength.toFixed(2)})`);
}

// --- REAL exact-12-FPS Linux /proc capture split into 3 repeats ---
{
  const here = dirname(fileURLToPath(import.meta.url));
  const cap = JSON.parse(readFileSync(join(here, '..', 'resource-usage-correlation', 'fixtures', 'linux-proc-12fps-capture.json'), 'utf8'));
  const s = cap.samples;
  const third = Math.floor(s.length / 3);
  const runs = [s.slice(0, third), s.slice(third, 2 * third), s.slice(2 * third)];
  const sig = buildSignature(runs, { stabilityThreshold: 0.5 });
  assert.equal(sig.repeats, 3);
  for (const k of ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec']) assert.ok(sig.counterKeys.includes(k), `real capture has ${k}`);
  assert.ok(Object.keys(sig.signatureVector).length > 0, 'real repeated capture yields a non-empty signature vector (stable structure survives)');
  assert.ok(sig.perCounter.memAvailableMb && typeof sig.perCounter.memAvailableMb.features.mean === 'number', 'real per-counter features computed');
  ok(`real EXACT-12-FPS capture (3 repeats) -> signature (${sig.counterKeys.length} counters, ${Object.keys(sig.signatureVector).length} stable features)`);
}

// --- guards ---
{
  assert.throws(() => buildSignature([]), 'empty runs throws');
  assert.throws(() => buildSignature([{ samples: [] }]), 'empty sample series throws');
  ok('empty runs / empty series guards throw');
}

console.log(`\nsignatureExtractor.selftest: ${passed}/${passed} checks passed`);
