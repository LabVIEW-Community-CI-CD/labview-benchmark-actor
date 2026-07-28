// labview-benchmark-actor — resource-usage <-> benchmark-frame correlation (LBA-REQ-011).
//
// Pure, dependency-free ESM (Node >= 18). Correlates a CPU / RAM / disk
// resource-sample series to the benchmark frame timeline on a shared
// epoch-ms / frame axis, and — anchored on a TRIGGER instant (e.g. the LabVIEW
// Getting-Started-Window-visible frame, or the benchmark-start marker) — computes
// a pre/post-trigger window analysis per metric so a downstream can read CPU,
// RAM, and disk usage BEFORE vs AFTER the trigger (the pre/post benchmark read).
//
// No I/O and no capture dependency: sampling (typeperf / logman / Get-Counter)
// and frame capture live in the capture harness; this module turns their data
// into a correlation model + a pre/post window summary. Deterministic: same
// input -> same output, so it is a re-runnable local-gate artifact.

export const RESOURCE_USAGE_CORRELATION_SCHEMA = 'labview-benchmark-actor/resource-usage-correlation@v1';
export const RESOURCE_USAGE_CORRELATION_SCHEMA_VERSION = 1;

/** The three correlated resource metrics and the sample field each reads. */
export const RESOURCE_METRIC_FIELDS = Object.freeze({
  cpu: 'cpuPct',
  ram: 'ramMb',
  disk: 'diskPct'
});

/** The metric keys in a stable order. */
export const RESOURCE_METRICS = Object.freeze(['cpu', 'ram', 'disk']);

/**
 * Resolve an epoch-ms instant to a frame index (floor of elapsed / interval).
 * Returns null before frame zero (never clamped to an unrelated frame).
 */
export function frameIndexOf(epochMs, epochMsAtFrameZero, frameIntervalMs) {
  const elapsed = epochMs - epochMsAtFrameZero;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return null;
  }
  return Math.floor(elapsed / frameIntervalMs);
}

/** Summarize a metric window; nulls (absent counter) are skipped. */
function summarizeWindow(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) {
    return { count: 0, mean: null, min: null, max: null };
  }
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

/** post.mean - pre.mean, or null when either window has no samples. */
function deltaMean(pre, post) {
  if (pre.mean === null || post.mean === null) {
    return null;
  }
  return post.mean - pre.mean;
}

/**
 * Build the resource-usage correlation model.
 *
 * @param {object} input
 * @param {number} [input.frameRateHz=12] positive capture frame rate (frames/sec).
 * @param {number} input.epochMsAtFrameZero epoch ms of frame 0 (the capture clock origin).
 * @param {number} input.triggerEpochMs epoch ms of the pre/post trigger (e.g. GSW-visible).
 * @param {Array<{epochMs:number, cpuPct?:number|null, ramMb?:number|null, diskPct?:number|null}>} input.samples
 *   resource samples in any order (sorted by epoch internally); each metric may
 *   be null when its counter was absent (skipped in the window summary).
 * @returns {object} a resource-usage-correlation@v1 model.
 */
export function buildResourceUsageCorrelation(input) {
  const frameRateHz = input && input.frameRateHz != null ? input.frameRateHz : 12;
  if (!(typeof frameRateHz === 'number' && Number.isFinite(frameRateHz) && frameRateHz > 0)) {
    throw new Error('buildResourceUsageCorrelation requires a positive frameRateHz.');
  }
  const epochMsAtFrameZero = input ? input.epochMsAtFrameZero : undefined;
  const triggerEpochMs = input ? input.triggerEpochMs : undefined;
  if (!Number.isFinite(epochMsAtFrameZero)) {
    throw new Error('buildResourceUsageCorrelation requires a finite epochMsAtFrameZero.');
  }
  if (!Number.isFinite(triggerEpochMs)) {
    throw new Error('buildResourceUsageCorrelation requires a finite triggerEpochMs.');
  }
  if (!input || !Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error('buildResourceUsageCorrelation requires a non-empty samples[].');
  }

  const frameIntervalMs = 1000 / frameRateHz;

  const sorted = [...input.samples].sort((a, b) => a.epochMs - b.epochMs);
  const correlatedSamples = sorted.map((s) => {
    if (!Number.isFinite(s.epochMs)) {
      throw new Error('every resource sample requires a finite epochMs.');
    }
    return {
      epochMs: s.epochMs,
      frameIndex: frameIndexOf(s.epochMs, epochMsAtFrameZero, frameIntervalMs),
      sinceTriggerMs: s.epochMs - triggerEpochMs,
      phase: s.epochMs < triggerEpochMs ? 'pre' : 'post',
      cpuPct: s.cpuPct == null ? null : s.cpuPct,
      ramMb: s.ramMb == null ? null : s.ramMb,
      diskPct: s.diskPct == null ? null : s.diskPct
    };
  });

  const pre = correlatedSamples.filter((s) => s.phase === 'pre');
  const post = correlatedSamples.filter((s) => s.phase === 'post');

  const windows = {};
  for (const metric of RESOURCE_METRICS) {
    const field = RESOURCE_METRIC_FIELDS[metric];
    const preWindow = summarizeWindow(pre.map((s) => s[field]));
    const postWindow = summarizeWindow(post.map((s) => s[field]));
    windows[metric] = {
      field,
      pre: preWindow,
      post: postWindow,
      deltaMean: deltaMean(preWindow, postWindow)
    };
  }

  return {
    schema: RESOURCE_USAGE_CORRELATION_SCHEMA,
    schemaVersion: RESOURCE_USAGE_CORRELATION_SCHEMA_VERSION,
    frameRateHz,
    frameIntervalMs,
    epochMsAtFrameZero,
    triggerEpochMs,
    triggerFrameIndex: frameIndexOf(triggerEpochMs, epochMsAtFrameZero, frameIntervalMs),
    sampleCount: correlatedSamples.length,
    preSampleCount: pre.length,
    postSampleCount: post.length,
    correlatedSamples,
    windows
  };
}
