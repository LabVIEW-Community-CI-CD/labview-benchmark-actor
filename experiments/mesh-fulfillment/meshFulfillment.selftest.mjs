#!/usr/bin/env node
// Self-test for the mesh-run fulfillment verifier (LBA-REQ-073 / ADR-0054). Pure + offline: proves the committed
// receipt validates + is derived from the real golden-VM actor receipts, and every fail-closed guard fires.
// Gated by `mesh-run-cross-plane-fulfillment`.
// Run: `node experiments/mesh-fulfillment/meshFulfillment.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './meshFulfillment.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'mesh-run-fulfillment-receipt.json'), 'utf8'));
const linuxTrend = JSON.parse(readFileSync(join(here, '..', 'launch-parity', 'fixtures', 'linux-launch-trend.json'), 'utf8'));
const winTrend = JSON.parse(readFileSync(join(here, '..', 'launch-parity', 'fixtures', 'win-launch-trend.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const DISPATCH = { benchmarkId: 'labview-ide-launch', benchmark: { metric: 'launchMs', workload: 'labview-ide-launch', n: 5 }, minActors: 2, requestedPlanes: ['LINUX', 'WIN'] };
const linuxActor = () => ({ actorId: 'golden-linux', role: 'golden', plane: 'LINUX', receipt: clone(linuxTrend) });
const winActor = () => ({ actorId: 'golden-win', role: 'golden', plane: 'WIN', receipt: clone(winTrend) });

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. committed receipt validates + run fulfilled.
ok('committed receipt validates (ok + proofOk)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed run should be fulfilled');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. buildReceipt round-trips from the real actor receipts + equals the committed receipt (grounded in real data).
ok('buildReceipt round-trips from the real actor receipts', () => {
  const built = buildReceipt({ dispatch: clone(DISPATCH), actors: [linuxActor(), winActor()] });
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.fulfilled, true);
  assert.equal(built.digest, committed.digest, 'the committed receipt is derived from the real golden-VM actor receipts');
});

// 3. FAIL-CLOSED: fewer than minActors distinct actors responded.
ok('rejects fewer than minActors', () => {
  const r = validateReceipt(buildReceipt({ dispatch: clone(DISPATCH), actors: [linuxActor()] }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /fewer than/.test(f)), 'expected a minActors finding');
});

// 4. FAIL-CLOSED: the responding actors do not COVER the requested planes (both LINUX, WIN missing).
ok('rejects actors that do not cover the requested planes', () => {
  const l2 = linuxActor(); l2.actorId = 'golden-linux-2';
  const r = validateReceipt(buildReceipt({ dispatch: clone(DISPATCH), actors: [linuxActor(), l2] }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /requested planes/.test(f)), 'expected a plane-coverage finding');
});

// 5. FAIL-CLOSED: an actor ran a DIFFERENT benchmark identity (cross-plane identity disagreement).
ok('rejects a cross-plane identity disagreement', () => {
  const w2 = winActor(); w2.receipt.workload = 'labview-other-launch'; // still a valid trend, but a different identity
  const r = validateReceipt(buildReceipt({ dispatch: clone(DISPATCH), actors: [linuxActor(), w2] }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /identity disagreement/.test(f)), 'expected an identity-disagreement finding');
});

// 6. FAIL-CLOSED: a duplicate actor responded (not distinct).
ok('rejects a duplicate actor (not distinct)', () => {
  const dup = winActor(); dup.actorId = 'golden-linux'; // same id as the linux actor
  const r = validateReceipt(buildReceipt({ dispatch: clone(DISPATCH), actors: [linuxActor(), dup] }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /not distinct/.test(f)), 'expected a distinctness finding');
});

// 7. FAIL-CLOSED: a tampered digest is rejected.
ok('rejects a tampered digest', () => {
  const r = clone(committed); r.digest = '0'.repeat(64);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-run-fulfillment selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
