#!/usr/bin/env node
// Self-test for the live fan-out contract (LBA-REQ-076 / ADR-0057). Pure + offline: proves the committed tasking
// derives from the dispatch (currency) + validates, the committed collection validates against the tasking and
// RECONSTRUCTS the committed LBA-REQ-073 fulfillment (grounding), and every fail-closed guard fires.
// Gated by `mesh-live-fanout-wired`.
// Run: `node experiments/mesh-fulfillment/meshFanout.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveTasking, buildCollection, collectionToActors, validateTasking, validateCollection, TASKING_SCHEMA, COLLECTION_SCHEMA, REQUIREMENT } from './meshFanout.mjs';
import { buildReceipt, decideFulfillment } from './meshFulfillment.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const dispatch = read('mesh-run-dispatch-request.json');
const tasking = read('mesh-run-tasking.json');
const collection = read('mesh-run-collection.json');
const fulfillment = read('mesh-run-fulfillment-receipt.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed tasking + collection validate against the committed dispatch.
ok('committed tasking + collection validate', () => {
  const vt = validateTasking(tasking, dispatch);
  assert.equal(vt.ok, true, `tasking should validate: ${vt.findings.join('; ')}`);
  const vc = validateCollection(collection, tasking);
  assert.equal(vc.ok, true, `collection should validate: ${vc.findings.join('; ')}`);
  assert.equal(tasking.schema, TASKING_SCHEMA);
  assert.equal(collection.schema, COLLECTION_SCHEMA);
  assert.equal(tasking.requirement, REQUIREMENT);
});

// 2. currency + grounding: deriveTasking reproduces the committed tasking byte-for-byte, and the collection's
//    actor set reconstructs the committed LBA-REQ-073 fulfillment (fulfilled).
ok('tasking is current + the collection reconstructs the committed fulfillment', () => {
  assert.equal(JSON.stringify(deriveTasking(dispatch)), JSON.stringify(tasking), 'committed tasking is stale vs the dispatch');
  const reconstructed = buildReceipt({ dispatch: fulfillment.dispatch, actors: collectionToActors(collection) });
  const decision = decideFulfillment(reconstructed);
  assert.equal(decision.fulfilled, true, `the collected actors must reconstruct a fulfilled run: ${decision.reasons.join('; ')}`);
  assert.equal(decision.identity, fulfillment.identity, 'the reconstructed run has the committed benchmark identity');
  assert.deepEqual(collectionToActors(collection).map((a) => a.actorId).sort(), fulfillment.actors.map((a) => a.actorId).sort(), 'the collected actors are the fulfillment actors');
});

// 3. FAIL-CLOSED: a tampered tasking digest.
ok('rejects a tampered tasking digest', () => {
  const t = clone(tasking); t.digest = '0'.repeat(64);
  const v = validateTasking(t, dispatch);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)));
});

// 4. FAIL-CLOSED: a task not bound to the dispatched identity.
ok('rejects a task unbound from the dispatched identity', () => {
  const t = clone(tasking); t.tasks[0].identity = 'f'.repeat(64);
  assert.equal(validateTasking(t, dispatch).ok, false);
});

// 5. FAIL-CLOSED: a collected receipt whose taskId has no matching task.
ok('rejects a collected receipt with no matching task', () => {
  const c = clone(collection); c.collected[0].taskId = 'mesh-run-labview-ide-launch-2026-08-03::MAC';
  assert.equal(validateCollection(c, tasking).ok, false);
});

// 6. FAIL-CLOSED: a collected receipt whose benchmark identity does not match the dispatched identity.
ok('rejects a collected receipt with a mismatched benchmark identity', () => {
  const c = clone(collection); c.collected[0].receipt.workload = 'some-other-workload';
  const v = validateCollection(c, tasking);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /identity|digest/.test(f)));
});

// 7. FAIL-CLOSED: a duplicate actor across two collected receipts.
ok('rejects a duplicate actor in the collection', () => {
  const c = clone(collection); c.collected[1].actorId = c.collected[0].actorId;
  assert.equal(validateCollection(c, tasking).ok, false);
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-live-fanout selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
