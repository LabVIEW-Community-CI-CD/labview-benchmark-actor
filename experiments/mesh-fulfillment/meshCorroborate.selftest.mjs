#!/usr/bin/env node
// meshCorroborate.selftest.mjs -- LBA-REQ-092 / ADR-0075. Deterministic proof that the run-bound cross-plane
// corroborate + compare stage (meshCorroborate.corroborateRun) corroborates a genuine two-plane run + reuses the
// benchmark-store compareRuns delta, and FAILS CLOSED on every corruption: a single-plane collection (not
// crossPlane), a non-PASS plane, a plane that ran a DIFFERENT benchmark (identity mismatch), a malformed
// collection, a non-trend receipt, a receipt whose plane disagrees with its collected plane, and an empty
// collection. Offline; no network, no disk fixtures -- the collection is built in-memory with identities that
// re-derive from the dispatched spec (dispatchIdentity), mirroring a real LBA-REQ-091 ingest output.

import { corroborateRun, REPORT_SCHEMA, COLLECTION_SCHEMA, TREND_SCHEMA } from './meshCorroborate.mjs';
import { dispatchIdentity } from './meshDispatch.mjs';

const SPEC = { metric: 'launchMs', workload: 'labview-ide-launch', n: 5 };
const IDENTITY = dispatchIdentity(SPEC);
const DISPATCH_ID = 'mesh-run-labview-ide-launch-test';

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  return { min: sorted[0], max: sorted[sorted.length - 1], mean, median: sorted[Math.floor(sorted.length / 2)], stddev: 0, spread: sorted[sorted.length - 1] - sorted[0] };
}

function mkTrend(plane, { values = [2400, 2500, 2600, 2500, 2450], verdict = 'PASS', metric = SPEC.metric, workload = SPEC.workload, n = SPEC.n } = {}) {
  return {
    schema: TREND_SCHEMA, metric, workload, plane, hypervisor: 'test', n,
    values, stats: stats(values), baselineMs: 2600, toleranceMs: 2000,
    latest: values[values.length - 1], slopeMsPerRun: 0, driftThresholdMsPerRun: 400,
    drifting: false, regressed: false, verdict,
  };
}

function mkCollected(plane, actorId, trend) {
  return { taskId: `${DISPATCH_ID}::${plane}`, actorId, plane, receipt: trend };
}

function mkCollection(collected, { identity = IDENTITY } = {}) {
  return {
    schema: COLLECTION_SCHEMA, requirement: 'LBA-REQ-076', adr: 'ADR-0057',
    dispatchId: DISPATCH_ID, identity, collected,
    actors: collected.map((c) => ({ actorId: c.actorId, plane: c.plane, receipt: c.receipt })),
    digest: 'test',
  };
}

let pass = 0;
let fail = 0;
function check(name, fn) { try { fn(); pass += 1; console.log(`  ok  ${name}`); } catch (e) { fail += 1; console.error(`  XX  ${name}: ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 1. genuine two-plane run corroborates + compares (reuses compareRuns for the delta)
check('two-plane run corroborates + compares', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX', { values: [2414, 2843, 2745, 2664, 2355] })),
    mkCollected('WIN', 'golden-win', mkTrend('WIN', { values: [3010, 3200, 3105, 2990, 3050] })),
  ]);
  const r = corroborateRun({ collection: col });
  assert(r.ok, `expected corroborated; findings: ${r.findings.join('; ')}`);
  assert(r.report.schema === REPORT_SCHEMA, 'report schema');
  assert(r.planes.join(',') === 'LINUX,WIN', 'spans both planes');
  assert(r.corroboration.crossPlane && r.corroboration.allPass && r.corroboration.identityBound, 'corroboration flags all true');
  assert(r.comparison && r.comparison.deltas.latest.delta === 3050 - 2355, 'compareRuns latest delta = WIN - LINUX');
  assert(r.report.identity === IDENTITY && r.report.dispatchId === DISPATCH_ID, 'report bound to dispatch identity + id');
});

// 2. single-plane collection is NOT cross-plane -> fail closed
check('single-plane fails closed (not crossPlane)', () => {
  const col = mkCollection([mkCollected('LINUX', 'golden-linux', mkTrend('LINUX'))]);
  const r = corroborateRun({ collection: col });
  assert(!r.ok && !r.corroboration.crossPlane && r.findings.some((f) => /not cross-plane/.test(f)), 'must fail not-crossPlane');
});

// 3. a non-PASS plane -> fail closed
check('non-PASS plane fails closed', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX')),
    mkCollected('WIN', 'golden-win', mkTrend('WIN', { verdict: 'REGRESSED' })),
  ]);
  const r = corroborateRun({ collection: col });
  assert(!r.ok && !r.corroboration.allPass && r.findings.some((f) => /not PASS/.test(f)), 'must fail non-PASS');
});

// 4. a plane that ran a DIFFERENT benchmark (identity mismatch) -> fail closed
check('identity mismatch fails closed (different benchmark)', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX')),
    mkCollected('WIN', 'golden-win', mkTrend('WIN', { n: 9 })), // n=9 -> different dispatch identity
  ]);
  const r = corroborateRun({ collection: col });
  assert(!r.ok && !r.corroboration.identityBound && r.findings.some((f) => /re-derive the dispatch identity/.test(f)), 'must fail identity mismatch');
});

// 5. malformed collection (wrong schema) -> fail closed
check('malformed collection fails closed', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX')),
    mkCollected('WIN', 'golden-win', mkTrend('WIN')),
  ]);
  col.schema = 'labview-benchmark-actor/not-a-collection@1';
  const r = corroborateRun({ collection: col });
  assert(!r.ok && r.findings.some((f) => /schema must be/.test(f)), 'must fail malformed collection');
});

// 6. a receipt that is not a workload-trend@1 -> fail closed
check('non-trend receipt fails closed', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX')),
    mkCollected('WIN', 'golden-win', { schema: 'labview-benchmark-actor/not-a-trend@1' }),
  ]);
  const r = corroborateRun({ collection: col });
  assert(!r.ok && r.findings.some((f) => /is not a valid/.test(f)), 'must fail non-trend receipt');
});

// 7. a receipt whose plane disagrees with its collected plane -> fail closed
check('plane mismatch fails closed', () => {
  const col = mkCollection([
    mkCollected('LINUX', 'golden-linux', mkTrend('LINUX')),
    mkCollected('WIN', 'golden-win', mkTrend('LINUX')), // collected WIN but trend.plane = LINUX
  ]);
  const r = corroborateRun({ collection: col });
  assert(!r.ok && r.findings.some((f) => /does not match the collected plane/.test(f)), 'must fail plane mismatch');
});

// 8. empty collection -> fail closed
check('empty collection fails closed', () => {
  const r = corroborateRun({ collection: mkCollection([]) });
  assert(!r.ok && r.findings.some((f) => /no collected receipts/.test(f)), 'must fail empty collection');
});

console.log(`\nmeshCorroborate selftest: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
