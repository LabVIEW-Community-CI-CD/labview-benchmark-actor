// labview-benchmark-actor -- performance-counter <-> benchmark-frame correlation (LBA-REQ-011, extended).
//
// Generalizes resourceUsageCorrelation (cpu/ram/disk only) to the FULL performance-counter catalog
// (performance-counter-correlation@v2): every sampled counter is correlated to the 12 FPS frame timeline
// on the shared epoch-ms/frame axis, and -- anchored on a trigger instant -- gets a pre/post-trigger window
// (count, mean, min, max, post-minus-pre delta) PER counter key. Pure, dependency-free ESM. Backward
// compatible: a legacy flat {cpuPct, ramMb, diskPct} sample is mapped onto the catalog keys, so the existing
// resource-correlated-launch@1 fixtures flow through unchanged. Deterministic: same input -> same output.

import { frameIndexOf } from './resourceUsageCorrelation.mjs';

export const PERFORMANCE_COUNTER_CORRELATION_SCHEMA = 'labview-benchmark-actor/performance-counter-correlation@v2';

/** Legacy flat sample fields -> performance-counter catalog keys (see performance-counter-schema.json). */
export const LEGACY_COUNTER_ALIASES = Object.freeze({
  cpuPct: 'cpuTotalPct',
  ramMb: 'ramProcessWorkingSetMb',
  diskPct: 'diskTotalPct'
});

/** Resolve a sample's counters: the v2 `counters` object, or a legacy flat sample mapped onto catalog keys. */
export function countersOf(sample) {
  if (sample && sample.counters && typeof sample.counters === 'object') return sample.counters;
  const c = {};
  for (const [flat, key] of Object.entries(LEGACY_COUNTER_ALIASES)) {
    if (sample && sample[flat] != null) c[key] = sample[flat];
  }
  return c;
}

function summarizeWindow(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { count: 0, mean: null, min: null, max: null };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of nums) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: nums.length, mean: sum / nums.length, min, max };
}

function deltaMean(pre, post) {
  return pre.mean === null || post.mean === null ? null : post.mean - pre.mean;
}

/**
 * Build the full performance-counter correlation model.
 *
 * @param {object} input
 * @param {number} [input.frameRateHz=12]
 * @param {number} input.epochMsAtFrameZero
 * @param {number} input.triggerEpochMs
 * @param {Array<{epochMs:number, counters?:object, cpuPct?:number, ramMb?:number, diskPct?:number}>} input.samples
 * @param {string[]} [input.counterKeys] explicit key set; default = the union of keys across all samples.
 * @returns {object} a performance-counter-correlation@v2 model with a pre/post window PER counter key.
 */
export function buildPerformanceCounterCorrelation(input) {
  const frameRateHz = input && input.frameRateHz != null ? input.frameRateHz : 12;
  if (!(typeof frameRateHz === 'number' && Number.isFinite(frameRateHz) && frameRateHz > 0)) {
    throw new Error('buildPerformanceCounterCorrelation requires a positive frameRateHz.');
  }
  const epochMsAtFrameZero = input ? input.epochMsAtFrameZero : undefined;
  const triggerEpochMs = input ? input.triggerEpochMs : undefined;
  if (!Number.isFinite(epochMsAtFrameZero)) throw new Error('requires a finite epochMsAtFrameZero.');
  if (!Number.isFinite(triggerEpochMs)) throw new Error('requires a finite triggerEpochMs.');
  if (!input || !Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error('buildPerformanceCounterCorrelation requires a non-empty samples[].');
  }

  const frameIntervalMs = 1000 / frameRateHz;
  const sorted = [...input.samples].sort((a, b) => a.epochMs - b.epochMs);

  let counterKeys;
  if (Array.isArray(input.counterKeys) && input.counterKeys.length) {
    counterKeys = [...input.counterKeys];
  } else {
    const set = new Set();
    for (const s of sorted) for (const k of Object.keys(countersOf(s))) set.add(k);
    counterKeys = [...set].sort();
  }

  const correlatedSamples = sorted.map((s) => {
    if (!Number.isFinite(s.epochMs)) throw new Error('every sample requires a finite epochMs.');
    const c = countersOf(s);
    const counters = {};
    for (const k of counterKeys) counters[k] = c[k] == null ? null : c[k];
    return {
      epochMs: s.epochMs,
      frameIndex: frameIndexOf(s.epochMs, epochMsAtFrameZero, frameIntervalMs),
      sinceTriggerMs: s.epochMs - triggerEpochMs,
      phase: s.epochMs < triggerEpochMs ? 'pre' : 'post',
      counters
    };
  });

  const pre = correlatedSamples.filter((s) => s.phase === 'pre');
  const post = correlatedSamples.filter((s) => s.phase === 'post');

  const perCounter = {};
  for (const key of counterKeys) {
    const preWindow = summarizeWindow(pre.map((s) => s.counters[key]));
    const postWindow = summarizeWindow(post.map((s) => s.counters[key]));
    perCounter[key] = { pre: preWindow, post: postWindow, deltaMean: deltaMean(preWindow, postWindow) };
  }

  return {
    schema: PERFORMANCE_COUNTER_CORRELATION_SCHEMA,
    frameRateHz,
    frameIntervalMs,
    epochMsAtFrameZero,
    triggerEpochMs,
    triggerFrameIndex: frameIndexOf(triggerEpochMs, epochMsAtFrameZero, frameIntervalMs),
    counterKeys,
    sampleCount: correlatedSamples.length,
    preSampleCount: pre.length,
    postSampleCount: post.length,
    correlatedSamples,
    perCounter
  };
}
