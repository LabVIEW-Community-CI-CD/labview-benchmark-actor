#!/usr/bin/env node
// Self-test for the mesh coverage observatory (LBA-REQ-075 / ADR-0056). Pure + offline: proves the committed
// observatory validates + coheres with the committed dispatch (074) + fulfillment (073) + parity (072) receipts
// it folds, and that every fail-closed guard fires. Gated by `mesh-coverage-observatory`.
// Run: `node experiments/mesh-fulfillment/meshObservatory.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildObservatory, validateObservatory, foldRun, RECEIPT_SCHEMA, REQUIREMENT } from './meshObservatory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const committed = read(join(here, 'mesh-coverage-observatory-receipt.json'));
const dispatch = read(join(here, 'mesh-run-dispatch-request.json'));
const fulfillment = read(join(here, 'mesh-run-fulfillment-receipt.json'));
const parity = read(join(here, '..', 'launch-parity', 'cross-plane-launch-parity-receipt.json'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed observatory validates AND is coherent (proofOk).
ok('committed observatory validates + is coherent', () => {
  const r = validateObservatory(committed);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed observatory should be coherent');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. re-folding the committed source receipts reproduces the committed observatory byte-for-byte (currency:
//    the committed dashboard reflects the real dispatch/fulfillment/parity it folds).
ok('re-fold of the committed source receipts reproduces the committed observatory', () => {
  const rebuilt = buildObservatory({ runs: [{ dispatch, fulfillment, parity }] });
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(committed), 'observatory is stale vs the source receipts');
  // and it is grounded: the folded row carries the real fulfillment identity + actor count + planes.
  const row = committed.rows[0];
  assert.equal(row.identity, fulfillment.identity, 'row identity must be the fulfillment identity');
  assert.equal(row.distinctActors, fulfillment.fulfillment.distinctActors, 'row actor count must be the real count');
  assert.deepEqual(row.planes, fulfillment.fulfillment.planes, 'row planes must be the real covered planes');
});

// 3. FAIL-CLOSED: a tampered digest.
ok('rejects a tampered digest', () => {
  const o = clone(committed); o.digest = '0'.repeat(64);
  const v = validateObservatory(o);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

// 4. FAIL-CLOSED: a flipped verdict (claim coherent when the rule disagrees, or vice-versa).
ok('rejects a verdict that contradicts the coherence rule', () => {
  const o = clone(committed); o.verdict.observatoryOk = !o.verdict.observatoryOk; o.digest = undefined;
  assert.equal(validateObservatory(o).ok, false);
});

// 5. FAIL-CLOSED: a miscounted coverage statistic.
ok('rejects a miscounted coverage statistic', () => {
  const o = clone(committed); o.coverage.totalDistinctActors += 1;
  assert.equal(validateObservatory(o).ok, false);
});

// 6. FAIL-CLOSED: a row that claims consistency without being dispatched + fulfilled.
ok('rejects a row claiming consistency without a dispatch + fulfillment', () => {
  const o = clone(committed); o.rows[0].fulfilled = false; o.rows[0].consistent = true;
  const v = validateObservatory(o);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /consistency|coverage|ledger|verdict/.test(f)));
});

// 7. FAIL-CLOSED at the fold: dispatch + fulfillment that disagree on identity are NOT folded as consistent.
ok('foldRun marks an identity-mismatched run inconsistent', () => {
  const badDispatch = clone(dispatch); badDispatch.identity = 'f'.repeat(64);
  const row = foldRun({ dispatch: badDispatch, fulfillment, parity });
  assert.equal(row.consistent, false, 'a dispatch/fulfillment identity mismatch must not be coherent');
  // and a coherent single-run observatory built from it must fail the coherence verdict.
  const o = buildObservatory({ runs: [{ dispatch: badDispatch, fulfillment, parity }] });
  assert.equal(o.verdict.observatoryOk, false);
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-coverage-observatory selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
