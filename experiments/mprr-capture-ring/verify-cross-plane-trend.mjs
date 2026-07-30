// verify-cross-plane-trend.mjs — deterministic self-test for the cross-plane trend-of-trends receipt.
// No VM: it validates the witness deltas (WIN - LINUX), the per-plane-regression gate (the cross-plane mean
// delta is a WITNESS and never fails), the drift/divergence flags, fail-closed on non-trend inputs, and a full
// build off the two REAL committed launchMs trends (WIN vmware + LINUX vbox).
//
// Run: node experiments/mprr-capture-ring/verify-cross-plane-trend.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossPlaneTrendReceipt } from './cross-plane-trend.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}

function trend(over) {
  return {
    schema: 'labview-benchmark-actor/workload-trend@1',
    metric: 'launchMs',
    workload: 'labview-ide-launch',
    plane: 'X',
    hypervisor: 'hv',
    n: 5,
    values: [1, 2, 3, 4, 5],
    stats: { min: 1, max: 5, mean: 3, median: 3, stddev: 1.4, spread: 4 },
    baselineMs: 3,
    toleranceMs: 2000,
    slopeMsPerRun: 0,
    driftThresholdMsPerRun: 400,
    drifting: false,
    regressed: false,
    verdict: 'PASS',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. witness deltas + faster-plane
// ---------------------------------------------------------------------------
console.log('witness deltas');
const win = trend({ plane: 'WIN', hypervisor: 'vmware-vnc', stats: { mean: 2410.6, median: 2309, stddev: 189, spread: 489 }, slopeMsPerRun: -50 });
const linux = trend({ plane: 'LINUX', hypervisor: 'vbox-vnc', stats: { mean: 2604.2, median: 2664, stddev: 189.1, spread: 488 }, slopeMsPerRun: -29.7 });
const r = crossPlaneTrendReceipt(win, linux);
check('meanDelta = WIN - LINUX', r.witness.meanDeltaMs === -193.6, String(r.witness.meanDeltaMs));
check('medianDelta = WIN - LINUX', r.witness.medianDeltaMs === -355);
check('slopeDelta rounded', r.witness.slopeDeltaMsPerRun === -20.3, String(r.witness.slopeDeltaMsPerRun));
check('spreadDelta', r.witness.spreadDeltaMs === 1);
check('faster plane = WIN (lower mean)', r.witness.faster === 'WIN');
check('witness within tol => match', r.witness.status === 'match');
check('both stable', r.bothStable === true);
check('verdict PASS', r.verdict === 'PASS');
check('no flags', r.flags.length === 0);

// ---------------------------------------------------------------------------
// 2. gate = per-plane regression (the cross-plane mean delta never fails)
// ---------------------------------------------------------------------------
console.log('per-plane regression gate');
const winReg = crossPlaneTrendReceipt(trend({ plane: 'WIN', regressed: true, verdict: 'REGRESSION' }), linux);
check('a regressed WIN trend -> REGRESSION verdict', winReg.verdict === 'REGRESSION' && winReg.regressedPlanes.includes('WIN'));
check('regressed plane is not bothStable', winReg.bothStable === false);
// A huge cross-hypervisor mean delta is a WITNESS: reported as diverged, but the gate still PASSES if both
// planes' own trends are non-regressed.
const diverged = crossPlaneTrendReceipt(trend({ plane: 'WIN', stats: { mean: 20000, median: 20000, spread: 4 } }), linux);
check('a large mean delta is a witness (diverged), not a gate fail', diverged.verdict === 'PASS' && diverged.witness.status === 'diverged');
check('divergence is flagged', diverged.flags.includes('mean-diverged'));
check('faster plane = LINUX when WIN is much slower', diverged.witness.faster === 'LINUX');

// ---------------------------------------------------------------------------
// 3. drift mismatch flag
// ---------------------------------------------------------------------------
console.log('drift mismatch');
const driftMix = crossPlaneTrendReceipt(trend({ plane: 'WIN', drifting: true }), linux);
check('one plane drifting -> drift-mismatch flag', driftMix.flags.includes('drift-mismatch'));
check('drift alone does not fail the gate', driftMix.verdict === 'PASS');

// ---------------------------------------------------------------------------
// 4. fail-closed on bad inputs
// ---------------------------------------------------------------------------
console.log('fail-closed');
let threw = 0;
try { crossPlaneTrendReceipt({}, linux); } catch { threw += 1; }
try { crossPlaneTrendReceipt(win, { schema: 'x' }); } catch { threw += 1; }
try { crossPlaneTrendReceipt(trend({ metric: 'launchMs' }), trend({ metric: 'bootMs' })); } catch { threw += 1; }
check('throws on non-trend WIN, non-trend LINUX, and metric mismatch', threw === 3, String(threw));

// determinism
check('deterministic', JSON.stringify(crossPlaneTrendReceipt(win, linux)) === JSON.stringify(r));

// ---------------------------------------------------------------------------
// 5. REAL committed trends build end-to-end
// ---------------------------------------------------------------------------
console.log('real committed trends');
const realWin = JSON.parse(readFileSync(join(HERE, 'fixtures', 'labview-launch-trend-win.json'), 'utf8'));
const realLinux = JSON.parse(readFileSync(join(HERE, 'fixtures', 'labview-launch-trend.json'), 'utf8'));
const real = crossPlaneTrendReceipt(realWin, realLinux);
check('real receipt schema', real.schema === 'labview-benchmark-actor/cross-plane-trend-receipt@1');
check('real WIN + LINUX planes carried', real.win.plane === 'WIN' && real.linux.plane === 'LINUX');
check('real cross-plane verdict PASS (both trends stable)', real.verdict === 'PASS');
check('real witness is a match (both ~2.4-2.6s launches)', real.witness.status === 'match');
console.log(`  ..   real: LINUX mean ${real.linux.mean} <-> WIN mean ${real.win.mean}  meanΔ ${real.witness.meanDeltaMs}ms  faster ${real.witness.faster}  ${real.verdict}`);

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error('verify-cross-plane-trend: ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('verify-cross-plane-trend: all checks passed');
