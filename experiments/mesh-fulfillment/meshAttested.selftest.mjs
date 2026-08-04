#!/usr/bin/env node
// Self-test for the composite mesh-run-attested decision (LBA-REQ-080 / ADR-0061). Pure + offline: proves the
// committed decision re-derives + is attested, and that breaking ANY one of the five composed sub-proofs (or the
// digest) flips the verdict to NOT attested. Gated by `mesh-run-attested`.
// Run: `node experiments/mesh-fulfillment/meshAttested.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideAttested, validateReceipt, committedContext, RECEIPT_SCHEMA, REQUIREMENT } from './meshAttested.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseCtx = committedContext(here);
const committed = JSON.parse(readFileSync(join(here, 'mesh-run-attested-receipt.json'), 'utf8'));
const ctx = () => JSON.parse(JSON.stringify(baseCtx));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed attested receipt validates + is attested (re-derives from the committed source receipts).
ok('committed attested receipt validates + is attested', () => {
  const r = validateReceipt(committed, baseCtx);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed run should be fully attested');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
  assert.equal(Object.values(committed.gates).every(Boolean), true, 'all five gates pass');
});

// 2. FAIL fulfillment (073): too few actors -> not attested.
ok('breaks when fulfillment fails', () => {
  const c = ctx(); c.fulfillment.actors = c.fulfillment.actors.slice(0, 1);
  const d = decideAttested(c);
  assert.equal(d.gates.fulfillment, false);
  assert.equal(d.attested, false);
});

// 3. FAIL cross-plane parity (072): a plane identity no longer matches -> not attested.
ok('breaks when parity fails', () => {
  const c = ctx(); c.parity.planes.LINUX.identity = 'f'.repeat(64);
  const d = decideAttested(c);
  assert.equal(d.gates.parity, false);
  assert.equal(d.attested, false);
});

// 4. FAIL verified tier (077): an actor is no longer enrolled -> not attested.
ok('breaks when the verified tier fails', () => {
  const c = ctx(); c.enrolledKeys = { ...c.enrolledKeys }; delete c.enrolledKeys[Object.keys(c.enrolledKeys)[0]];
  const d = decideAttested(c);
  assert.equal(d.gates.verifiedTier, false);
  assert.equal(d.attested, false);
});

// 5. FAIL transparency inclusion (078): the wrong log key -> the signed tree head does not verify -> not attested.
ok('breaks when the transparency inclusion fails', () => {
  const c = ctx(); c.logPublicKeyPem = c.historyPublicKeyPem; // a valid PEM, but the wrong key for the 078 STH
  const d = decideAttested(c);
  assert.equal(d.gates.transparencyInclusion, false);
  assert.equal(d.attested, false);
});

// 6. FAIL append-only (079): the wrong history key -> the tree heads do not verify -> not attested.
ok('breaks when the append-only proof fails', () => {
  const c = ctx(); c.historyPublicKeyPem = c.logPublicKeyPem; // the wrong key for the 079 history heads
  const d = decideAttested(c);
  assert.equal(d.gates.appendOnly, false);
  assert.equal(d.attested, false);
});

// 7. FAIL a tampered attested-receipt digest.
ok('rejects a tampered attested-receipt digest', () => {
  const bad = JSON.parse(JSON.stringify(committed)); bad.digest = '0'.repeat(64);
  const r = validateReceipt(bad, baseCtx);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-run-attested selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
