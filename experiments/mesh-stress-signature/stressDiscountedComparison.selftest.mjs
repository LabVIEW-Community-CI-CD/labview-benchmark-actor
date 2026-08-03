#!/usr/bin/env node
// Self-test for the stress-discounted cross-plane comparison (LBA-REQ-084 / ADR-0065). Pure + offline: proves the
// committed comparison re-derives from the committed mesh-stress calibration + concurrent captures, discounts the
// stressed actors while keeping the clean ones, and every fail-closed guard fires. Gated by
// `stress-discounted-comparison`. Run: `node experiments/mesh-stress-signature/stressDiscountedComparison.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildComparison, validateComparison, committedContext, qualityWeight, RECEIPT_SCHEMA, REQUIREMENT } from './stressDiscountedComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseCtx = committedContext(here);
const committed = JSON.parse(readFileSync(join(here, 'stress-discounted-comparison-receipt.json'), 'utf8'));
const ctx = () => JSON.parse(JSON.stringify(baseCtx));
const clone = () => JSON.parse(JSON.stringify(committed));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed comparison validates + discounting is applied.
ok('committed stress-discounted comparison validates + applies discounting', () => {
  const r = validateComparison(committed, baseCtx);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'discounting should be applied');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. it re-derives from the committed mesh-stress receipts (currency) + discounts the stressed actors while
//    keeping the clean ones at full confidence (grounding: idle -> weight 1.0, saturate -> weight 0.0).
ok('re-derives from the committed calibration + concurrent captures', () => {
  assert.equal(JSON.stringify(buildComparison(baseCtx)), JSON.stringify(committed), 'comparison is stale');
  const byActor = Object.fromEntries(committed.measurements.map((m) => [m.inferredRung, m]));
  assert.equal(byActor.idle.qualityWeight, 1, 'idle actor kept at full confidence');
  assert.equal(byActor.idle.discounted, false, 'idle actor not discounted');
  assert.equal(byActor.saturate.qualityWeight, 0, 'saturate actor weighted to zero');
  assert.equal(byActor.saturate.discounted, true, 'saturate actor discounted');
  assert.ok(committed.coverage.discountedCount >= 1 && committed.coverage.cleanCount >= 1, 'a clean/discounted split');
});

// 3. FAIL-CLOSED: a weight that does not match its inferred stress level.
ok('rejects a weight inconsistent with the stress level', () => {
  const c = clone(); c.measurements[0].qualityWeight = 0.5; c.digest = undefined;
  assert.equal(validateComparison(c).ok, false);
});

// 4. FAIL-CLOSED: a discounted flag inconsistent with the stress level.
ok('rejects an inconsistent discounted flag', () => {
  const c = clone(); const idle = c.measurements.find((m) => m.inferredRung === 'idle'); idle.discounted = true; idle.qualityWeight = qualityWeight(idle.inferredLevel);
  const r = validateComparison(c);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /discounted flag/.test(f)));
});

// 5. FAIL-CLOSED: an untrustworthy calibration (the stress ladder is not separable) -> not applied + stale.
ok('rejects an untrustworthy calibration', () => {
  const c = ctx(); c.ladder.invariants.separable = false;
  const rebuilt = buildComparison(c);
  assert.equal(rebuilt.verdict.discountingApplied, false);
  assert.equal(validateComparison(rebuilt, c).proofOk, false);
});

// 6. FAIL-CLOSED: an actor the calibration could not recover -> discounting not trustworthy.
ok('rejects when an actor was not recovered', () => {
  const c = ctx(); c.concurrent.perActorInverseRead[0].correct = false; c.concurrent.allActorsRecovered = false;
  const rebuilt = buildComparison(c);
  assert.equal(rebuilt.verdict.discountingApplied, false);
});

// 7. FAIL-CLOSED: a tampered digest.
ok('rejects a tampered digest', () => {
  const c = clone(); c.digest = '0'.repeat(64);
  const r = validateComparison(c, baseCtx);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest|stale/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# stress-discounted-comparison selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
