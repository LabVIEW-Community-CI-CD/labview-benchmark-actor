// cross-plane-trend.mjs — the CROSS-PLANE TREND-OF-TRENDS receipt. Given two sealed workload-trend@1 records
// (WIN + LINUX), each a REAL continuous run of N LabVIEW IDE launches (launchMs per run), compare the two
// trends and seal a re-runnable cross-plane receipt. This is to the per-plane launchMs TREND what
// workload-cross-plane.mjs (#191) is to a single launch: it lifts the cross-plane comparison from one run to a
// whole trend.
//
// The cross-plane MEAN difference is a WITNESS: a cross-HYPERVISOR launch time carries real substrate bias
// (VMware VM vs VBox VM), so the mean/median deltas are measured + reported, never hard-failed (mirrors the
// #191 launch witness). The GATE is per-plane regression: the receipt is PASS unless a plane's own trend
// regressed. Divergence (a large mean delta) or a drift mismatch is flagged, not failed.
//
//   import { crossPlaneTrendReceipt } from './cross-plane-trend.mjs'
//   node experiments/mprr-capture-ring/cross-plane-trend.mjs <winTrend.json> <linuxTrend.json> [--out receipt.json]

import { readFileSync, writeFileSync } from 'node:fs';

const TREND_SCHEMA = 'labview-benchmark-actor/workload-trend@1';

function requireTrend(t, label) {
  if (!t || t.schema !== TREND_SCHEMA) {
    throw new Error(`crossPlaneTrendReceipt: ${label} is not a ${TREND_SCHEMA} record`);
  }
  if (!t.stats || typeof t.stats.mean !== 'number') {
    throw new Error(`crossPlaneTrendReceipt: ${label} has no stats.mean`);
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Build the cross-plane trend receipt from two workload-trend@1 records.
 * @param {object} winTrend   the WIN plane's launchMs trend (candidate)
 * @param {object} linuxTrend the LINUX plane's launchMs trend (baseline)
 * @param {{witnessToleranceMs?:number}} [opts] witnessToleranceMs = the cross-hypervisor mean-delta band that
 *   still reads as a "match" (substrate bias); beyond it the witness reads "diverged" (reported, never fails).
 * @returns {object} cross-plane-trend-receipt@1
 */
export function crossPlaneTrendReceipt(winTrend, linuxTrend, opts = {}) {
  requireTrend(winTrend, 'winTrend');
  requireTrend(linuxTrend, 'linuxTrend');
  if (winTrend.metric !== linuxTrend.metric) {
    throw new Error(`crossPlaneTrendReceipt: metric mismatch (WIN ${winTrend.metric} vs LINUX ${linuxTrend.metric})`);
  }
  const witnessToleranceMs = typeof opts.witnessToleranceMs === 'number' ? opts.witnessToleranceMs : 8000;

  const plane = (t) => ({
    plane: t.plane ?? null,
    hypervisor: t.hypervisor ?? null,
    n: t.n ?? (Array.isArray(t.values) ? t.values.length : null),
    mean: t.stats.mean,
    median: t.stats.median ?? null,
    stddev: t.stats.stddev ?? null,
    spread: t.stats.spread ?? null,
    slopeMsPerRun: t.slopeMsPerRun ?? null,
    baselineMs: t.baselineMs ?? null,
    verdict: t.verdict ?? (t.regressed ? 'REGRESSION' : 'PASS'),
    regressed: Boolean(t.regressed),
    drifting: Boolean(t.drifting),
  });
  const win = plane(winTrend);
  const linux = plane(linuxTrend);

  // Witness: cross-hypervisor deltas (WIN candidate - LINUX baseline). Substrate bias, reported not gated.
  const meanDeltaMs = round1(win.mean - linux.mean);
  const medianDeltaMs = win.median != null && linux.median != null ? round1(win.median - linux.median) : null;
  const slopeDeltaMsPerRun =
    win.slopeMsPerRun != null && linux.slopeMsPerRun != null ? round1(win.slopeMsPerRun - linux.slopeMsPerRun) : null;
  const spreadDeltaMs = win.spread != null && linux.spread != null ? win.spread - linux.spread : null;
  const witnessStatus = Math.abs(meanDeltaMs) <= witnessToleranceMs ? 'match' : 'diverged';

  // Flags: notable but non-gating cross-plane observations.
  const flags = [];
  if (win.drifting !== linux.drifting) flags.push('drift-mismatch');
  if (witnessStatus === 'diverged') flags.push('mean-diverged');

  // Gate: PASS unless a plane's OWN trend regressed. The cross-plane mean delta never fails the gate.
  const regressedPlanes = [win.regressed && 'WIN', linux.regressed && 'LINUX'].filter(Boolean);
  const verdict = regressedPlanes.length === 0 ? 'PASS' : 'REGRESSION';
  const bothStable = !win.regressed && !linux.regressed && !win.drifting && !linux.drifting;

  return {
    schema: 'labview-benchmark-actor/cross-plane-trend-receipt@1',
    metric: winTrend.metric,
    workload: winTrend.workload ?? linuxTrend.workload ?? 'unknown',
    win,
    linux,
    witness: {
      meanDeltaMs, // WIN - LINUX
      medianDeltaMs,
      slopeDeltaMsPerRun,
      spreadDeltaMs,
      toleranceMs: witnessToleranceMs,
      status: witnessStatus, // 'match' | 'diverged' — never fails the gate
      faster: meanDeltaMs === 0 ? 'tie' : meanDeltaMs < 0 ? 'WIN' : 'LINUX',
    },
    flags,
    regressedPlanes,
    bothStable,
    verdict, // PASS unless a plane's own trend regressed
    rerun: 'node experiments/mprr-capture-ring/cross-plane-trend.mjs',
  };
}

const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  const norm = arg.replace(/\\/g, '/');
  return import.meta.url === `file://${norm}` || import.meta.url.endsWith('/' + norm.split('/').pop());
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  const [winPath, linuxPath] = positional;
  if (!winPath || !linuxPath) {
    console.error('usage: cross-plane-trend.mjs <winTrend.json> <linuxTrend.json> [--out receipt.json]');
    process.exit(2);
  }
  const receipt = crossPlaneTrendReceipt(
    JSON.parse(readFileSync(winPath, 'utf8')),
    JSON.parse(readFileSync(linuxPath, 'utf8'))
  );
  const w = receipt.witness;
  console.log(`cross-plane trend (${receipt.workload} ${receipt.metric}): ${receipt.verdict}`);
  console.log(`  LINUX mean ${receipt.linux.mean} (${receipt.linux.verdict}) <-> WIN mean ${receipt.win.mean} (${receipt.win.verdict})`);
  console.log(`  witness meanΔ ${w.meanDeltaMs}ms  ${w.status}  (faster: ${w.faster}, tol ${w.toleranceMs})`);
  if (receipt.flags.length) console.log(`  flags: ${receipt.flags.join(', ')}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`receipt -> ${outPath}`);
  }
  process.exitCode = receipt.verdict === 'PASS' ? 0 : 1;
}
