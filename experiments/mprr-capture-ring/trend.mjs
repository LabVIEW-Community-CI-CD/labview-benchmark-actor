// trend.mjs — CONTINUOUS / TREND analysis for visual-ring workload benchmarks. Given a SERIES of workload records
// (or raw metric samples) for the same workload+metric — e.g. launchMs over N repeated LabVIEW launches — compute
// the trend: descriptive stats (min/mean/median/stddev/spread), a REGRESSION verdict vs a baseline (the latest run
// slower than baseline + toleranceMs), and a DRIFT slope (least-squares ms/run — a gradual slowdown). This turns a
// one-shot benchmark into a continuous signal: run it every commit / on a schedule and track the metric over time.
// Pure + deterministic -> gated with synthetic series.

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Build a workload-trend record from a series of samples.
 * @param {{series:Array<number|object>, metric?:string, baselineMs?:number|null, toleranceMs?:number,
 *          driftThresholdMsPerRun?:number|null, meta?:object}} args
 *   series: raw ms numbers OR boot-benchmark-v1 records (the `metric` span's ms is extracted, in order).
 *   baselineMs: the established baseline; defaults to the series MEDIAN (robust). Regression = latest > baseline+tol.
 *   driftThresholdMsPerRun: when set, `drifting` = |slope| exceeds it (a gradual run-over-run trend).
 * @returns {object} a workload-trend@1 record.
 */
export function buildTrend({ series, metric = 'launchMs', baselineMs = null, toleranceMs = 2000, driftThresholdMsPerRun = null, meta = {} }) {
  if (!Array.isArray(series) || series.length < 2) {
    throw new Error('trend: a series of >= 2 samples is required');
  }
  const values = series.map((s, i) => {
    if (typeof s === 'number') return s;
    const span = (s.spans ?? []).find((sp) => sp.id === metric);
    if (!span || !Number.isFinite(span.ms)) throw new Error(`trend: series[${i}] has no finite '${metric}' span`);
    return span.ms;
  });
  if (values.some((v) => !Number.isFinite(v))) throw new Error('trend: all samples must be finite');

  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const stddev = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const spread = max - min;
  // least-squares slope (ms per run) over run index 0..n-1 -> a gradual drift signal.
  const xbar = (n - 1) / 2;
  const num = values.reduce((a, v, i) => a + (i - xbar) * (v - mean), 0);
  const den = values.reduce((a, _v, i) => a + (i - xbar) ** 2, 0);
  const slopeMsPerRun = den ? num / den : 0;

  const baseline = Number.isFinite(baselineMs) ? baselineMs : median;
  const latest = values[n - 1];
  const regressed = latest > baseline + toleranceMs;
  const drifting = driftThresholdMsPerRun != null && Math.abs(slopeMsPerRun) > driftThresholdMsPerRun;
  return {
    schema: 'labview-benchmark-actor/workload-trend@1',
    metric,
    workload: meta.workload ?? null,
    plane: meta.plane ?? null,
    hypervisor: meta.hypervisor ?? null,
    n,
    values,
    stats: { min, max, mean: round1(mean), median, stddev: round1(stddev), spread },
    baselineMs: baseline,
    toleranceMs,
    latest,
    slopeMsPerRun: round1(slopeMsPerRun),
    ...(driftThresholdMsPerRun != null ? { driftThresholdMsPerRun, drifting } : {}),
    regressed,
    verdict: regressed ? 'REGRESSION' : 'PASS',
  };
}
