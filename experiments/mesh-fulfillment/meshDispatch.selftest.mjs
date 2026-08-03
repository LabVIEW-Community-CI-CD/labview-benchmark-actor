#!/usr/bin/env node
// Self-test for the mesh-run dispatch contract (LBA-REQ-074 / ADR-0055). Pure + offline: proves the committed
// dispatch request validates + binds to the LBA-REQ-073 fulfillment (same benchmark identity), and every
// fail-closed guard fires. Gated by `mesh-run-dispatch-wired`.
// Run: `node experiments/mesh-fulfillment/meshDispatch.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRequest, validateRequest, REQUEST_SCHEMA, REQUIREMENT } from './meshDispatch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'mesh-run-dispatch-request.json'), 'utf8'));
const fulfillment = JSON.parse(readFileSync(join(here, 'mesh-run-fulfillment-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const SPEC = {
  dispatchId: 'd-test', benchmarkId: 'labview-ide-launch',
  benchmark: { metric: 'launchMs', workload: 'labview-ide-launch', n: 5 },
  minActors: 2, requestedPlanes: ['LINUX', 'WIN'],
};

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. committed request validates + BINDS to the LBA-REQ-073 fulfillment (same benchmarkId + identity).
ok('committed request validates + binds to the fulfillment', () => {
  const r = validateRequest(committed);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(committed.schema, REQUEST_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
  assert.equal(committed.benchmarkId, fulfillment.dispatch.benchmarkId, 'dispatch + fulfillment target the same benchmarkId');
  assert.equal(committed.identity, fulfillment.identity, 'dispatch + fulfillment share the same benchmark identity (same run)');
});

// 2. buildRequest round-trips.
ok('buildRequest round-trips', () => {
  const built = buildRequest(SPEC);
  assert.equal(validateRequest(built).ok, true);
});

// 3. FAIL-CLOSED: a missing benchmarkId.
ok('rejects a missing benchmarkId', () => {
  const r = clone(committed); r.benchmarkId = ''; r.digest = undefined; // will fail well-formed + digest
  assert.equal(validateRequest(r).ok, false);
});

// 4. FAIL-CLOSED: minActors below 1.
ok('rejects minActors < 1', () => {
  assert.equal(validateRequest(buildRequest({ ...SPEC, minActors: 0 })).ok, false);
});

// 5. FAIL-CLOSED: an empty requested-planes set.
ok('rejects an empty requestedPlanes set', () => {
  assert.equal(validateRequest(buildRequest({ ...SPEC, requestedPlanes: [] })).ok, false);
});

// 6. FAIL-CLOSED: an invalid plane.
ok('rejects an invalid plane', () => {
  assert.equal(validateRequest(buildRequest({ ...SPEC, requestedPlanes: ['LINUX', 'MAC'] })).ok, false);
});

// 7. FAIL-CLOSED: a tampered digest.
ok('rejects a tampered digest', () => {
  const r = clone(committed); r.digest = '0'.repeat(64);
  const v = validateRequest(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-run-dispatch selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
