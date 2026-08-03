#!/usr/bin/env node
// Self-test for the benchmark-suite parity observatory (LBA-REQ-082 / ADR-0063). Pure + offline: proves the
// committed observatory validates + re-derives from the committed cross-plane parity receipts (launch 072 + VI
// Analyzer 081), and every fail-closed guard fires. Gated by `benchmark-suite-parity-observatory`.
// Run: `node experiments/benchmark-suite/suiteParityObservatory.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildObservatory, validateObservatory, foldParity, committedReceipts, RECEIPT_SCHEMA, REQUIREMENT } from './suiteParityObservatory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipts = committedReceipts(here);
const committed = JSON.parse(readFileSync(join(here, 'benchmark-suite-parity-observatory-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed observatory validates + the whole suite is parity-proven.
ok('committed suite observatory validates + is complete', () => {
  const r = validateObservatory(committed);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'the whole suite should be parity-proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. it re-derives from the committed parity receipts (currency) + is grounded (row identities are the real
//    parity-receipt identities; the two families are launch + vi-analyzer).
ok('re-derives from the committed parity receipts + is grounded', () => {
  const rebuilt = buildObservatory({ receipts });
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(committed), 'observatory is stale vs the parity receipts');
  const byFamily = Object.fromEntries(committed.rows.map((r) => [r.family, r]));
  assert.ok(byFamily.launch && byFamily['vi-analyzer'], 'both benchmark families are folded');
  for (const receipt of receipts) {
    const identity = receipt.launchIdentity ?? receipt.benchmarkIdentity;
    assert.ok(committed.rows.some((r) => r.identity === identity), `a row carries the real identity for ${receipt.schema}`);
  }
});

// 3. FAIL-CLOSED: a row claims parity without cross-plane + identity match.
ok('rejects a row claiming parity without cross-plane + identity match', () => {
  const o = clone(committed); o.rows[0].crossPlane = false;
  assert.equal(validateObservatory(o).ok, false);
});

// 4. FAIL-CLOSED: a miscounted coverage statistic.
ok('rejects a miscounted coverage statistic', () => {
  const o = clone(committed); o.coverage.parityProvenCount += 1;
  assert.equal(validateObservatory(o).ok, false);
});

// 5. FAIL-CLOSED: a verdict that contradicts the folded rows.
ok('rejects a verdict that contradicts the rows', () => {
  const o = clone(committed); o.verdict.observatoryOk = !o.verdict.observatoryOk; o.digest = undefined;
  assert.equal(validateObservatory(o).ok, false);
});

// 6. FAIL-CLOSED: a folded parity receipt that is not parity-proven -> the suite is not complete.
ok('is not complete when a family is not parity-proven', () => {
  const bad = clone(receipts); bad[1].verdict.parityProven = false; bad[1].parity.parityProven = false;
  const o = buildObservatory({ receipts: bad });
  assert.equal(o.verdict.observatoryOk, false);
  assert.equal(validateObservatory(o).proofOk, false);
});

// 7. FAIL-CLOSED: a tampered digest.
ok('rejects a tampered digest', () => {
  const o = clone(committed); o.digest = '0'.repeat(64);
  const r = validateObservatory(o);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# benchmark-suite-parity-observatory selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
