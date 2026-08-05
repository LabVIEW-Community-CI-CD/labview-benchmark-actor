#!/usr/bin/env node
// Self-test for the run-bound mesh ingestion seam (LBA-REQ-091 / ADR-0074). Pure + offline: proves a live dispatch
// + the actors' returned plane-tagged receipts ingest into a valid run-bound tasking + collection, AND every
// fail-closed guard fires (uncovered plane, plane mismatch, identity mismatch, unbound task, duplicate actor,
// malformed dispatch, malformed returned receipt). Reuses the real fanout validators (meshFanout). Gated by
// `mesh-run-ingest`.  Run: `node experiments/mesh-fulfillment/meshIngest.selftest.mjs`.

import assert from 'node:assert/strict';
import { ingestRun, returnedOk, RETURNED_SCHEMA } from './meshIngest.mjs';
import { dispatchIdentity } from './meshDispatch.mjs';

const BENCH = { metric: 'launchMs', workload: 'labview-ide-launch', n: 5 };
const DID = 'mesh-run-selftest-2026-08-04';

const mkDispatch = (over = {}) => {
  const benchmark = over.benchmark ?? BENCH;
  return {
    schema: 'labview-benchmark-actor/mesh-run-dispatch@1', requirement: 'LBA-REQ-074', adr: 'ADR-0055',
    dispatchId: over.dispatchId ?? DID, benchmarkId: over.benchmarkId ?? 'labview-ide-launch', benchmark,
    identity: over.identity ?? dispatchIdentity(benchmark), minActors: over.minActors ?? 2,
    requestedPlanes: over.requestedPlanes ?? ['LINUX', 'WIN'],
  };
};

// A valid workload-trend@1 whose identity (metric,workload,n) matches the benchmark spec for that plane.
const mkTrend = (plane, over = {}) => {
  const metric = over.metric ?? BENCH.metric, workload = over.workload ?? BENCH.workload, n = over.n ?? BENCH.n;
  const base = plane === 'WIN' ? 3200 : 2400;
  const values = Array.from({ length: n }, (_, i) => base + i * 10);
  return {
    schema: 'labview-benchmark-actor/workload-trend@1', metric, workload, plane,
    hypervisor: plane === 'WIN' ? 'vmware' : 'vbox-vnc', n, values,
    stats: { min: values[0], max: values[n - 1], mean: base + (n - 1) * 5, median: values[Math.floor((n - 1) / 2)], stddev: 15.5, spread: (n - 1) * 10 },
    baselineMs: base + 100, toleranceMs: 2000, latest: values[n - 1], slopeMsPerRun: 10, driftThresholdMsPerRun: 400,
    drifting: false, regressed: false, verdict: 'PASS',
  };
};

const mkReturned = (plane, actorId, over = {}) => ({
  schema: RETURNED_SCHEMA,
  taskId: over.taskId ?? `${DID}::${plane}`,
  actorId,
  plane: over.plane ?? plane,
  receipt: over.receipt ?? mkTrend(plane, over.trend),
});

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. a live dispatch + a LINUX + WIN returned receipt ingest into a valid run-bound collection.
ok('ingests a genuine two-plane run (ok + 2 actors)', () => {
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux'), mkReturned('WIN', 'golden-win')] });
  assert.equal(r.ok, true, `should ingest: ${r.findings.join('; ')}`);
  assert.equal(r.actors.length, 2);
  assert.deepEqual(r.actors.map((a) => a.plane).sort(), ['LINUX', 'WIN']);
});

// 2. FAIL CLOSED -- an uncovered requested plane (only LINUX returned, WIN missing).
ok('rejects an uncovered requested plane', () => {
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux')] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /cover the tasked planes/.test(f)), 'expected an uncovered-plane finding');
});

// 3. FAIL CLOSED -- a returned receipt whose declared plane != its receipt's plane.
ok('rejects a plane mismatch (declared vs receipt)', () => {
  const bad = mkReturned('WIN', 'golden-win', { receipt: mkTrend('LINUX') }); // says WIN, carries a LINUX trend
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux'), bad] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /receipt plane/.test(f)), 'expected a plane-mismatch finding');
});

// 4. FAIL CLOSED -- a returned receipt whose identity (different n) != the dispatched identity.
ok('rejects a receipt identity != the dispatched identity', () => {
  const bad = mkReturned('WIN', 'golden-win', { trend: { n: 9 } }); // different n -> different launchIdentity
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux'), bad] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /identity/.test(f)), 'expected an identity finding');
});

// 5. FAIL CLOSED -- a returned receipt whose taskId is not bound to this dispatch (no matching task).
ok('rejects an unbound taskId', () => {
  const bad = mkReturned('WIN', 'golden-win', { taskId: 'some-other-dispatch::WIN' });
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux'), bad] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /no matching task/.test(f)), 'expected an unbound-task finding');
});

// 6. FAIL CLOSED -- two returned receipts from the SAME actor (a padded quorum).
ok('rejects a duplicate actor', () => {
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'dup'), mkReturned('WIN', 'dup')] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /duplicate actor/.test(f)), 'expected a duplicate-actor finding');
});

// 7. FAIL CLOSED -- a malformed dispatch (missing benchmarkId).
ok('rejects a malformed dispatch', () => {
  const d = mkDispatch(); delete d.benchmarkId;
  const r = ingestRun({ dispatch: d, returned: [mkReturned('LINUX', 'golden-linux'), mkReturned('WIN', 'golden-win')] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /malformed mesh-run-dispatch/.test(f)), 'expected a malformed-dispatch finding');
});

// 8. FAIL CLOSED -- a malformed returned receipt (wrong schema) is not silently dropped into a short quorum.
ok('rejects a malformed returned receipt', () => {
  const bad = { schema: 'nope', taskId: `${DID}::WIN`, actorId: 'golden-win', plane: 'WIN', receipt: mkTrend('WIN') };
  assert.equal(returnedOk(bad), false);
  const r = ingestRun({ dispatch: mkDispatch(), returned: [mkReturned('LINUX', 'golden-linux'), bad] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /malformed returned-receipt/.test(f)), 'expected a malformed-returned finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# meshIngest selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
