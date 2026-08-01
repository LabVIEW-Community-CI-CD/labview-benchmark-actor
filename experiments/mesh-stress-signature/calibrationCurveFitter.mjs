// labview-benchmark-actor -- mesh-stress CALIBRATION-CURVE fitter (mesh-stress-signature@v1, builds on the
// signature extractor + performance-counter-correlation@v2 / LBA-REQ-011).
//
// Given the per-rung SIGNATURES along a stress LADDER (idle -> saturate), fit a calibration curve per
// counter-feature dimension: stressRung -> expected value + tolerance band (from the across-repeat variance).
// Score the design invariants -- MONOTONE (salient features track the rung), SEPARABLE (adjacent rungs' bands
// don't overlap for >= K dimensions), REPEATABLE (each rung has stable signature features) -- and provide the
// INVERSE READ: map an observed signature back to its inferred stress level with a confidence. Non-monotone
// features are flagged (a counter that does not track stress is not salient and is dropped from the calibration).
// Pure, dependency-free ESM, deterministic.

import { PER_COUNTER_FEATURES } from './signatureExtractor.mjs';

export const MESH_CALIBRATION_SCHEMA = 'labview-benchmark-actor/mesh-stress-calibration@v1';

/** 'increasing' | 'decreasing' | null (not monotone within tol). */
function monotoneDirection(vals, tol) {
  let inc = true;
  let dec = true;
  for (let i = 1; i < vals.length; i += 1) {
    if (vals[i] < vals[i - 1] - tol) inc = false;
    if (vals[i] > vals[i - 1] + tol) dec = false;
  }
  return inc ? 'increasing' : (dec ? 'decreasing' : null);
}

function observedValue(observed, key, feature) {
  const pc = observed && observed.perCounter && observed.perCounter[key];
  if (pc && pc.features && Number.isFinite(pc.features[feature])) return pc.features[feature];
  if (observed && Number.isFinite(observed[`${key}.${feature}`])) return observed[`${key}.${feature}`];
  return null;
}

/**
 * Fit a calibration curve from the ladder of per-rung signatures.
 * @param {Array<{rung:string, level:number, signature:object}>} rungs signatures (buildSignature output) per rung.
 * @param {object} [opts] { bandK=2, monotoneTol=0, separableMinDims=1, salientRangeFactor=1 }
 */
export function fitCalibrationCurve(rungs, opts = {}) {
  if (!Array.isArray(rungs) || rungs.length < 2) throw new Error('fitCalibrationCurve requires >= 2 rungs.');
  if (rungs.some((r) => !r || !r.signature || !Array.isArray(r.signature.counterKeys))) {
    throw new Error('every rung requires a signature (buildSignature output).');
  }
  const bandK = opts.bandK ?? 2;
  const monotoneTol = opts.monotoneTol ?? 0;
  const separableMinDims = opts.separableMinDims ?? 1;
  const sorted = [...rungs].sort((a, b) => a.level - b.level);

  // counter keys present at EVERY rung (a dimension must span the ladder to be calibratable)
  const sets = sorted.map((r) => new Set(r.signature.counterKeys));
  const counterKeys = [...sets[0]].filter((k) => sets.every((s) => s.has(k))).sort();

  const perFeature = {};
  for (const key of counterKeys) {
    for (const f of PER_COUNTER_FEATURES) {
      const curve = sorted.map((r) => {
        const pc = r.signature.perCounter[key];
        const expected = pc && pc.features ? pc.features[f] : null;
        const cov = pc && pc.acrossRepeatCoV ? pc.acrossRepeatCoV[f] : null;
        const tolerance = (Number.isFinite(expected) && Number.isFinite(cov)) ? bandK * Math.abs(cov * expected) : null;
        return { rung: r.rung, level: r.level, expected, tolerance };
      });
      const exp = curve.map((c) => c.expected);
      if (!exp.every((v) => Number.isFinite(v))) continue; // dimension missing at some rung
      const dir = monotoneDirection(exp, monotoneTol);
      const range = Math.max(...exp) - Math.min(...exp);
      const tolsSorted = curve.map((c) => c.tolerance).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      const medianTolerance = tolsSorted.length ? tolsSorted[Math.floor(tolsSorted.length / 2)] : 0;
      const salient = dir != null && range > Math.max(medianTolerance * (opts.salientRangeFactor ?? 1), 1e-9);
      perFeature[`${key}.${f}`] = { key, feature: f, curve, monotone: dir, range, medianTolerance, salient };
    }
  }

  const salientDimensions = Object.keys(perFeature).filter((d) => perFeature[d].salient).sort();

  // separability: at each adjacent rung boundary a salient dimension is separable when the two rungs' bands
  // [expected +/- tolerance] do not overlap (the ladder is resolvable on that dimension there).
  const separability = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const dims = [];
    for (const d of salientDimensions) {
      const c = perFeature[d].curve;
      const a = c[i];
      const b = c[i + 1];
      if (![a.expected, b.expected, a.tolerance, b.tolerance].every(Number.isFinite)) continue;
      const overlap = !((a.expected + a.tolerance) < (b.expected - b.tolerance) || (b.expected + b.tolerance) < (a.expected - a.tolerance));
      if (!overlap) dims.push(d);
    }
    separability.push({ from: sorted[i].rung, to: sorted[i + 1].rung, separableDims: dims.length, dims });
  }

  const invariants = {
    monotone: salientDimensions.length ? salientDimensions.filter((d) => perFeature[d].monotone != null).length / salientDimensions.length : 0,
    separable: separability.length > 0 && separability.every((s) => s.separableDims >= separableMinDims),
    repeatable: sorted.every((r) => Object.keys(r.signature.signatureVector || {}).length > 0)
  };

  return {
    schema: MESH_CALIBRATION_SCHEMA,
    rungs: sorted.map((r) => ({ rung: r.rung, level: r.level })),
    counterKeys,
    salientDimensions,
    perFeature,
    separability,
    invariants
  };
}

/**
 * Inverse read: map an OBSERVED signature to its inferred stress rung + confidence.
 * @param {object} model a fitCalibrationCurve output.
 * @param {object} observed a signature (buildSignature output) or a flat { 'key.feature': value } map.
 * @param {object} [opts] { dimensions? subset of salient dims to use }
 */
export function inverseRead(model, observed, opts = {}) {
  const dims = (Array.isArray(opts.dimensions) && opts.dimensions.length) ? opts.dimensions : model.salientDimensions;
  if (!dims.length) throw new Error('inverseRead requires salient dimensions in the model.');
  const distancePerRung = model.rungs.map((r, idx) => {
    let sum = 0;
    let n = 0;
    for (const d of dims) {
      const pf = model.perFeature[d];
      if (!pf) continue;
      const exp = pf.curve[idx].expected;
      const obs = observedValue(observed, pf.key, pf.feature);
      if (!Number.isFinite(exp) || !Number.isFinite(obs)) continue;
      const denom = Math.max(pf.curve[idx].tolerance || 0, Math.abs(pf.range) / model.rungs.length, 1e-9);
      sum += Math.abs(obs - exp) / denom;
      n += 1;
    }
    return { rung: r.rung, level: r.level, distance: n ? sum / n : Infinity };
  });
  const best = distancePerRung.reduce((a, b) => (b.distance < a.distance ? b : a));
  return { inferredRung: best.rung, inferredLevel: best.level, confidence: 1 / (1 + best.distance), distancePerRung };
}
