// verify-trend.mjs — proves the continuous/trend analysis (trend.mjs) with SYNTHETIC series: stats correctness,
// a stable series -> PASS, a late spike -> REGRESSION vs baseline, a gradual slope -> drift detected, an explicit
// baseline override, boot-benchmark-v1 records as input (span extraction), and fail-closed on < 2 samples.
// Run: node experiments/mprr-capture-ring/verify-trend.mjs

import assert from 'node:assert/strict';
import { buildTrend } from './trend.mjs';

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// 1) Stats + slope correctness on a perfectly linear series.
const t1 = buildTrend({ series: [10, 20, 30, 40, 50], toleranceMs: 1000 });
assert.equal(t1.n, 5);
assert.deepEqual(t1.stats, { min: 10, max: 50, mean: 30, median: 30, stddev: 14.1, spread: 40 });
assert.equal(t1.slopeMsPerRun, 10, 'least-squares slope = 10 ms/run for a +10/run series');
ok('descriptive stats + least-squares slope are correct');

// 2) A stable launch series -> PASS (latest within baseline + tolerance).
const stable = buildTrend({ series: [2500, 2577, 2540, 2560, 2530], metric: 'launchMs', toleranceMs: 2000, meta: { workload: 'labview-ide-launch', plane: 'LINUX' } });
assert.equal(stable.verdict, 'PASS');
assert.equal(stable.regressed, false);
assert.equal(stable.baselineMs, 2540, 'default baseline = the series median');
ok('a stable launchMs series -> PASS (no regression)');

// 3) A late spike -> REGRESSION vs the (median) baseline.
const spike = buildTrend({ series: [2500, 2530, 2560, 2540, 9000], toleranceMs: 2000 });
assert.equal(spike.verdict, 'REGRESSION');
assert.equal(spike.regressed, true);
assert.equal(spike.latest, 9000);
ok('a late spike -> REGRESSION (latest > baseline + tolerance)');

// 4) A gradual slope -> drift detected (reported independently of the regression verdict).
const drift = buildTrend({ series: [2000, 2500, 3000, 3500, 4000], toleranceMs: 2000, driftThresholdMsPerRun: 300 });
assert.equal(drift.slopeMsPerRun, 500, 'slope = 500 ms/run');
assert.equal(drift.drifting, true, 'drift detected (|slope| > threshold)');
ok('a gradual run-over-run slope -> drift detected');

// 5) Explicit baseline override.
const based = buildTrend({ series: [2500, 2600, 5000], baselineMs: 2500, toleranceMs: 2000 });
assert.equal(based.baselineMs, 2500);
assert.equal(based.verdict, 'REGRESSION', 'latest 5000 > baseline 2500 + tol 2000');
ok('explicit baselineMs override drives the regression check');

// 6) boot-benchmark-v1 records as input -> extracts the metric span.
const rec = (ms) => ({ schema: 'labview-benchmark-actor/boot-benchmark-v1', spans: [{ id: 'launchMs', ms, clock: 'host', scope: 'cross-plane' }] });
const fromRecords = buildTrend({ series: [rec(2500), rec(2600), rec(2550)], metric: 'launchMs', toleranceMs: 2000 });
assert.deepEqual(fromRecords.values, [2500, 2600, 2550], 'launchMs extracted from each record in order');
assert.equal(fromRecords.verdict, 'PASS');
ok('accepts boot-benchmark-v1 records + extracts the metric span');

// 7) Fail-closed.
assert.throws(() => buildTrend({ series: [2500] }), />= 2 samples/, '< 2 samples -> fail closed');
assert.throws(() => buildTrend({ series: [rec(2500), { spans: [] }], metric: 'launchMs' }), /no finite 'launchMs' span/, 'a record missing the metric span -> fail closed');
ok('fail-closed on too few samples + a record missing the metric span');

console.log(`\nworkload-trend self-test: ${passed}/7 PASS`);
