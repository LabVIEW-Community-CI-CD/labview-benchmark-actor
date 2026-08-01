// labview-benchmark-actor -- mesh-stress performance-SIGNATURE extractor (mesh-stress-signature@v1, builds on
// performance-counter-correlation@v2 / LBA-REQ-011).
//
// A performance SIGNATURE fingerprints "this actor at this stress level" as the REPETITIVE (structural/periodic)
// and OUTLIER (anomalous) patterns of the per-counter series across MULTIPLE REPEATED benchmarks. Structure that
// survives repeats is signature; what varies across repeats is the noise floor. Pure, dependency-free ESM
// (Node builtins only), deterministic: same input -> same output, so it is a re-runnable local-gate artifact.
//
// Input: an array of R repeated RUNS; each run is a series of samples { epochMs, counters:{key:number} } (the v2
// shape, e.g. from linuxProcSampler / a launch-capture record). Output: per-counter feature vectors, an
// across-repeat STABILITY classification (signature vs noise by coefficient-of-variation), the outlier profile,
// and cross-counter outlier co-occurrence within the +/-200 ms marker tolerance.

export const MESH_SIGNATURE_SCHEMA = 'labview-benchmark-actor/mesh-stress-signature@v1';
export const PER_COUNTER_FEATURES = Object.freeze([
  'mean', 'std', 'p50', 'p95', 'p99', 'min', 'max', 'driftSlope', 'dominantPeriodMs', 'periodicityStrength', 'outlierRate'
]);

const numbers = (xs) => xs.filter((v) => typeof v === 'number' && Number.isFinite(v));

function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function meanOf(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function stdOf(xs, mean) {
  if (xs.length < 2) return 0;
  const m = mean == null ? meanOf(xs) : mean;
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) * (v - m), 0) / (xs.length - 1));
}

/** Least-squares slope of value vs elapsed-ms (per-second drift). */
function driftSlopePerSec(epochs, vals) {
  const n = vals.length;
  if (n < 2) return 0;
  const t0 = epochs[0];
  const xs = epochs.map((e) => (e - t0) / 1000); // seconds
  const mx = meanOf(xs);
  const my = meanOf(vals);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (vals[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den === 0 ? 0 : num / den;
}

/** MAD-based outlier indices (|v - median| > k * 1.4826 * MAD). Robust to the outliers themselves. */
function outlierIndices(vals, k) {
  const sorted = [...vals].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  const absdev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = quantile(absdev, 0.5);
  let scale = 1.4826 * mad;
  if (!(scale > 0)) {
    // MAD collapses to 0 when >50% of samples are identical; fall back to std-around-median so a lone spike
    // against an otherwise-constant series is still caught.
    scale = stdOf(vals, meanOf(vals));
  }
  if (!(scale > 0)) return []; // truly flat series -> no outliers
  const out = [];
  for (let i = 0; i < vals.length; i += 1) if (Math.abs(vals[i] - med) > k * scale) out.push(i);
  return out;
}

/** Dominant period via normalized autocorrelation; returns { periodMs, strength(0..1) }. */
function dominantPeriod(vals, frameIntervalMs) {
  const n = vals.length;
  if (n < 8) return { dominantPeriodMs: null, periodicityStrength: 0 };
  const m = meanOf(vals);
  const centered = vals.map((v) => v - m);
  const denom = centered.reduce((a, v) => a + v * v, 0);
  if (!(denom > 0)) return { dominantPeriodMs: null, periodicityStrength: 0 };
  let bestLag = 0;
  let bestR = 0;
  const maxLag = Math.floor(n / 2);
  for (let lag = 2; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 1) s += centered[i] * centered[i + lag];
    const r = s / denom;
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  return bestLag > 0
    ? { dominantPeriodMs: Math.round(bestLag * frameIntervalMs), periodicityStrength: Math.max(0, Math.min(1, bestR)) }
    : { dominantPeriodMs: null, periodicityStrength: 0 };
}

/** Per-counter feature vector for one run's value series (epoch-aligned). */
export function runFeatures(epochs, rawVals, opts = {}) {
  const outlierMadK = opts.outlierMadK ?? 3;
  const frameIntervalMs = opts.frameIntervalMs ?? 1000 / (opts.frameRateHz ?? 12);
  const pairs = rawVals.map((v, i) => [epochs[i], v]).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  const eps = pairs.map((p) => p[0]);
  const vals = pairs.map((p) => p[1]);
  if (vals.length === 0) return { count: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = meanOf(vals);
  const oi = outlierIndices(vals, outlierMadK);
  const per = dominantPeriod(vals, frameIntervalMs);
  return {
    count: vals.length,
    mean,
    std: stdOf(vals, mean),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    driftSlope: driftSlopePerSec(eps, vals),
    dominantPeriodMs: per.dominantPeriodMs,
    periodicityStrength: per.periodicityStrength,
    outlierRate: oi.length / vals.length,
    outlierEpochs: oi.map((i) => eps[i])
  };
}

function coeffOfVariation(xs) {
  const v = numbers(xs);
  if (v.length < 2) return 0;
  const m = meanOf(v);
  if (m === 0) return v.every((x) => x === 0) ? 0 : Infinity;
  return Math.abs(stdOf(v, m) / m);
}

function countersOf(sample) {
  return sample && sample.counters && typeof sample.counters === 'object' ? sample.counters : {};
}

/**
 * Extract a performance signature from R repeated runs.
 * @param {Array<{samples:Array<{epochMs:number,counters:object}>}> | Array<Array<{epochMs:number,counters:object}>>} runs
 * @param {object} [opts] { stabilityThreshold=0.15, outlierMadK=3, toleranceMs=200, frameRateHz=12, counterKeys? }
 */
export function buildSignature(runs, opts = {}) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('buildSignature requires a non-empty runs[].');
  const stabilityThreshold = opts.stabilityThreshold ?? 0.15;
  const toleranceMs = opts.toleranceMs ?? 200;
  const frameRateHz = opts.frameRateHz ?? 12;
  const series = runs.map((r) => (Array.isArray(r) ? r : (r && Array.isArray(r.samples) ? r.samples : [])));
  if (series.some((s) => s.length === 0)) throw new Error('every run requires a non-empty sample series.');

  let counterKeys;
  if (Array.isArray(opts.counterKeys) && opts.counterKeys.length) {
    counterKeys = [...opts.counterKeys];
  } else {
    const set = new Set();
    for (const s of series) for (const sm of s) for (const k of Object.keys(countersOf(sm))) set.add(k);
    counterKeys = [...set].sort();
  }

  // per-run per-counter features
  const perRun = series.map((s) => {
    const epochs = s.map((sm) => sm.epochMs);
    const out = {};
    for (const key of counterKeys) out[key] = runFeatures(epochs, s.map((sm) => countersOf(sm)[key]), { outlierMadK: opts.outlierMadK, frameRateHz });
    return out;
  });

  // aggregate across repeats -> stability (CoV) per feature
  const perCounter = {};
  const signatureVector = {};
  for (const key of counterKeys) {
    const feats = {};
    const stable = {};
    const acrossRepeatCoV = {};
    for (const f of PER_COUNTER_FEATURES) {
      const vals = perRun.map((rf) => (rf[key] ? rf[key][f] : null));
      const acrossMean = meanOf(numbers(vals));
      const cov = coeffOfVariation(vals);
      feats[f] = acrossMean;
      acrossRepeatCoV[f] = cov;
      stable[f] = Number.isFinite(cov) && cov <= stabilityThreshold;
      if (stable[f]) signatureVector[`${key}.${f}`] = acrossMean;
    }
    perCounter[key] = {
      features: feats,
      acrossRepeatCoV,
      signatureFeatures: PER_COUNTER_FEATURES.filter((f) => stable[f]),
      noiseFeatures: PER_COUNTER_FEATURES.filter((f) => !stable[f]),
      outlierEpochsByRun: perRun.map((rf) => (rf[key] ? rf[key].outlierEpochs : []))
    };
  }

  // cross-counter: counter pairs whose outliers co-occur within +/-toleranceMs (shared-cause signature)
  const crossCounter = [];
  for (let a = 0; a < counterKeys.length; a += 1) {
    for (let b = a + 1; b < counterKeys.length; b += 1) {
      const ka = counterKeys[a];
      const kb = counterKeys[b];
      let coOccurrences = 0;
      for (let r = 0; r < perRun.length; r += 1) {
        const ea = (perRun[r][ka] && perRun[r][ka].outlierEpochs) || [];
        const eb = (perRun[r][kb] && perRun[r][kb].outlierEpochs) || [];
        for (const t of ea) if (eb.some((u) => Math.abs(u - t) <= toleranceMs)) coOccurrences += 1;
      }
      if (coOccurrences > 0) crossCounter.push({ a: ka, b: kb, coOccurrences });
    }
  }
  crossCounter.sort((x, y) => y.coOccurrences - x.coOccurrences);

  return {
    schema: MESH_SIGNATURE_SCHEMA,
    repeats: series.length,
    stabilityThreshold,
    toleranceMs,
    counterKeys,
    sampleCounts: series.map((s) => s.length),
    perCounter,
    crossCounter,
    signatureVector
  };
}
