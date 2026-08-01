// Self-test for captureAndCorrelate.mjs -- proven on REAL data (no fakes): the committed live receipt captured
// on this host (an EXACTLY-12-FPS /proc series with a REAL CPU+disk burst fired at the trigger frame). Replays
// the detector code (decideDetection / rankMovers) over the committed real correlation and guards it against
// false positives with synthetic idle/rise models. Deterministic. Run: node captureAndCorrelate.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideDetection, rankMovers, EXPECTED_RISERS, DETECTION_THRESHOLDS, LIVE_CORRELATION_SCHEMA } from './captureAndCorrelate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rj = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- REAL committed live receipt: EXACTLY 12 FPS + a real burst detected across the trigger ---
const receipt = rj('fixtures/linux-proc-12fps-correlated-trigger.json');
{
  assert.equal(receipt.schema, LIVE_CORRELATION_SCHEMA, 'live receipt schema');
  const m = receipt.capture.measured;
  assert.equal(m.exactly12fps, true, 'the live capture must be EXACTLY 12 FPS (frame-lock held under load)');
  assert.ok(Math.abs(receipt.capture.frameIntervalMs - 1000 / 12) < 1e-6, 'frame interval is exactly 1000/12 ms');
  assert.ok(m.medianPhaseErrorMs <= 5, `median frame-lock error stays tight under load (<=5 ms), got ${m.medianPhaseErrorMs}`);
  assert.ok(receipt.trigger.triggerFrameIndex > 0 && receipt.trigger.triggerFrameIndex < receipt.capture.sampleCount, 'trigger frame lies inside the capture');
  assert.equal(receipt.detection.triggerDetected, true, 'the real burst must be detected across the trigger');
  ok(`REAL live receipt: ${receipt.capture.sampleCount} samples @ ${m.effectiveFps.toFixed(3)} FPS, trigger@frame ${receipt.trigger.triggerFrameIndex} detected`);
}

// --- Re-derive the detection THROUGH THE CODE from the committed real per-counter windows ---
{
  const model = { counterKeys: receipt.correlation.counterKeys, perCounter: receipt.correlation.perCounter };
  const decision = decideDetection(model);
  assert.equal(decision.triggerDetected, true, 're-derived detection over the real correlation must also fire');
  assert.ok(decision.detectedBy.length >= 1 && decision.detectedBy.every((d) => EXPECTED_RISERS.includes(d.key)), 'detection is driven only by expected risers');
  for (const d of decision.detectedBy) assert.ok(d.deltaMean >= DETECTION_THRESHOLDS[d.key], `${d.key} cleared its threshold`);
  const committed = receipt.detection.detectedBy.map((d) => d.key).sort();
  assert.deepEqual(decision.detectedBy.map((d) => d.key).sort(), committed, 'code re-derives the committed detectedBy set');
  const top = rankMovers(model);
  assert.ok(top.length > 0 && Math.abs(top[0].score) >= Math.abs(top[top.length - 1].score), 'movers sorted by |score| desc');
  ok(`detector re-derives the real detection (${committed.join(', ')}); top mover = ${top[0].key}`);
}

// --- False-positive guard: an IDLE synthetic model (all deltas ~0) must NOT detect ---
{
  const idle = {
    counterKeys: [...EXPECTED_RISERS],
    perCounter: Object.fromEntries(EXPECTED_RISERS.map((k) => [k, { pre: { mean: 3, count: 10 }, post: { mean: 3.01, count: 10 }, deltaMean: 0.01 }]))
  };
  assert.equal(decideDetection(idle).triggerDetected, false, 'a flat/idle correlation must not report a trigger');
  ok('idle synthetic correlation -> no false-positive detection');
}

// --- Positive guard: a synthetic CPU rise over threshold MUST detect ---
{
  const rise = {
    counterKeys: ['cpuTotalPct'],
    perCounter: { cpuTotalPct: { pre: { mean: 4, count: 10 }, post: { mean: 40, count: 10 }, deltaMean: 36 } }
  };
  const d = decideDetection(rise);
  assert.equal(d.triggerDetected, true, 'a clear CPU rise over threshold must detect');
  assert.equal(d.detectedBy[0].key, 'cpuTotalPct');
  ok('synthetic CPU rise over threshold -> detected');
}

console.log(`\ncaptureAndCorrelate.selftest: ${passed}/${passed} checks passed (REAL data)`);
