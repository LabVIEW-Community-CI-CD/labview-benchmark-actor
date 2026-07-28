#!/usr/bin/env node
// labview-benchmark-actor — resource-usage-correlation self-test + receipt producer
// (LBA-REQ-011, T-011). Dependency-free ESM.
//
// Re-runnable local-gate artifact: exercises buildResourceUsageCorrelation over a
// canonical synthetic CPU/RAM/disk series with a pre/post trigger, asserts the
// correlation + pre/post window math, and writes a DETERMINISTIC receipt.json
// (no timestamps) so re-generation is byte-stable and diff-free.
//
// Usage:
//   node experiments/resource-usage-correlation/verify-resource-correlation.mjs [--json]
// Exit code 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildResourceUsageCorrelation,
  frameIndexOf,
  RESOURCE_METRICS,
  RESOURCE_USAGE_CORRELATION_SCHEMA
} from './resourceUsageCorrelation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');

// Canonical synthetic run: frame 0 at epoch 1000, GSW-visible trigger at 2000.
// Samples are supplied UNSORTED to exercise the internal sort. CPU/RAM/disk all
// rise after the trigger (the cold-launch pressure the benchmark reads).
const CANONICAL_INPUT = {
  frameRateHz: 12,
  epochMsAtFrameZero: 1000,
  triggerEpochMs: 2000,
  samples: [
    { epochMs: 1500, cpuPct: 8, ramMb: 410, diskPct: 3 },
    { epochMs: 1000, cpuPct: 5, ramMb: 400, diskPct: 2 },
    { epochMs: 2500, cpuPct: 55, ramMb: 650, diskPct: 35 },
    { epochMs: 2000, cpuPct: 60, ramMb: 500, diskPct: 40 },
    { epochMs: 3000, cpuPct: 40, ramMb: 700, diskPct: 20 },
    { epochMs: 3500, cpuPct: 20, ramMb: 680, diskPct: 10 }
  ]
};

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error: String(error && error.message ? error.message : error) });
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const correlation = buildResourceUsageCorrelation(CANONICAL_INPUT);

check('schema-and-shape', () => {
  assert(correlation.schema === RESOURCE_USAGE_CORRELATION_SCHEMA, 'schema mismatch');
  assert(correlation.schemaVersion === 1, 'schemaVersion must be 1');
  assert(correlation.sampleCount === 6, `sampleCount ${correlation.sampleCount} != 6`);
  assert(correlation.preSampleCount === 2, `preSampleCount ${correlation.preSampleCount} != 2`);
  assert(correlation.postSampleCount === 4, `postSampleCount ${correlation.postSampleCount} != 4`);
});

check('trigger-lands-on-frame-12', () => {
  assert(correlation.triggerFrameIndex === 12, `triggerFrameIndex ${correlation.triggerFrameIndex} != 12`);
});

check('samples-sorted-and-frame-index-monotonic', () => {
  const epochs = correlation.correlatedSamples.map((s) => s.epochMs);
  const frames = correlation.correlatedSamples.map((s) => s.frameIndex);
  for (let i = 1; i < epochs.length; i += 1) {
    assert(epochs[i] >= epochs[i - 1], `epochs not sorted at index ${i}`);
    assert(frames[i] >= frames[i - 1], `frameIndex not monotonic at index ${i}`);
  }
  assert(frames.join(',') === '0,6,12,18,24,30', `unexpected frame indices: ${frames.join(',')}`);
});

check('phase-split-on-trigger', () => {
  for (const s of correlation.correlatedSamples) {
    const expected = s.epochMs < correlation.triggerEpochMs ? 'pre' : 'post';
    assert(s.phase === expected, `sample @${s.epochMs} phase ${s.phase} != ${expected}`);
    assert(s.sinceTriggerMs === s.epochMs - correlation.triggerEpochMs, 'sinceTriggerMs mismatch');
  }
});

check('cpu-ram-disk-window-means-and-deltas', () => {
  assert(correlation.windows.cpu.pre.mean === 6.5, `cpu pre mean ${correlation.windows.cpu.pre.mean} != 6.5`);
  assert(correlation.windows.cpu.post.mean === 43.75, `cpu post mean ${correlation.windows.cpu.post.mean} != 43.75`);
  assert(correlation.windows.cpu.deltaMean === 37.25, `cpu deltaMean ${correlation.windows.cpu.deltaMean} != 37.25`);
  assert(correlation.windows.ram.deltaMean === 227.5, `ram deltaMean ${correlation.windows.ram.deltaMean} != 227.5`);
  assert(correlation.windows.disk.deltaMean === 23.75, `disk deltaMean ${correlation.windows.disk.deltaMean} != 23.75`);
});

check('every-metric-window-well-formed-and-rising', () => {
  for (const metric of RESOURCE_METRICS) {
    const w = correlation.windows[metric];
    assert(typeof w.field === 'string' && w.field.length > 0, `${metric} field missing`);
    for (const phase of ['pre', 'post']) {
      const s = w[phase];
      assert(typeof s.count === 'number' && s.count > 0, `${metric}.${phase}.count must be > 0`);
      assert(typeof s.mean === 'number' && typeof s.min === 'number' && typeof s.max === 'number', `${metric}.${phase} summary must be numeric`);
      assert(s.min <= s.mean && s.mean <= s.max, `${metric}.${phase} min<=mean<=max violated`);
    }
    assert(typeof w.deltaMean === 'number' && w.deltaMean > 0, `${metric} deltaMean must be a positive number (usage rises after trigger)`);
  }
});

check('null-counter-samples-skipped-in-window', () => {
  const model = buildResourceUsageCorrelation({
    frameRateHz: 12,
    epochMsAtFrameZero: 0,
    triggerEpochMs: 100,
    samples: [
      { epochMs: 0, cpuPct: 10, ramMb: 100, diskPct: 1 },
      { epochMs: 200, cpuPct: null, ramMb: 200, diskPct: 5 },
      { epochMs: 300, cpuPct: 30, ramMb: 300, diskPct: 9 }
    ]
  });
  assert(model.windows.cpu.post.count === 1, `cpu post count ${model.windows.cpu.post.count} != 1 (null skipped)`);
  assert(model.windows.cpu.post.mean === 30, `cpu post mean ${model.windows.cpu.post.mean} != 30`);
  assert(model.windows.ram.post.count === 2, `ram post count ${model.windows.ram.post.count} != 2`);
});

check('frame-index-null-before-frame-zero', () => {
  assert(frameIndexOf(500, 1000, 1000 / 12) === null, 'instant before frame zero must map to null');
  assert(frameIndexOf(1000, 1000, 1000 / 12) === 0, 'frame-zero instant must map to frame 0');
});

check('fail-closed-on-invalid-input', () => {
  assert(throws(() => buildResourceUsageCorrelation({ frameRateHz: 0, epochMsAtFrameZero: 0, triggerEpochMs: 1, samples: [{ epochMs: 0 }] })), 'non-positive frameRateHz must throw');
  assert(throws(() => buildResourceUsageCorrelation({ epochMsAtFrameZero: Number.NaN, triggerEpochMs: 1, samples: [{ epochMs: 0 }] })), 'non-finite epochMsAtFrameZero must throw');
  assert(throws(() => buildResourceUsageCorrelation({ epochMsAtFrameZero: 0, triggerEpochMs: Number.NaN, samples: [{ epochMs: 0 }] })), 'non-finite triggerEpochMs must throw');
  assert(throws(() => buildResourceUsageCorrelation({ epochMsAtFrameZero: 0, triggerEpochMs: 1, samples: [] })), 'empty samples must throw');
});

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;

const receipt = {
  schemaVersion: 'labview-benchmark-actor/resource-usage-correlation-receipt-v1',
  generatedBy: 'experiments/resource-usage-correlation/verify-resource-correlation.mjs',
  total: checks.length,
  passed,
  failed,
  results: checks,
  correlation
};

writeFileSync(join(here, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else {
  for (const c of checks) {
    process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  -- ${c.error}`}\n`);
  }
  process.stdout.write(`\n${passed}/${checks.length} resource-usage-correlation checks passed\n`);
}

process.exit(failed === 0 ? 0 : 1);
