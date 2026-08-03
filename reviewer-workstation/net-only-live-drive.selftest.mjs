#!/usr/bin/env node
// Self-test for the net-only-live-drive receipt verifier (LBA-REQ-068 / ADR-0049). Pure + offline: proves the
// committed receipt validates AND that every fail-closed guard fires. Gated by `net-only-live-drive` in
// experiments/verify-local-gates.mjs. Run: `node reviewer-workstation/net-only-live-drive.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, digestReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './net-only-live-drive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'net-only-live-drive-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reseal = (r) => { r.digest = digestReceipt(r); return r; };

let n = 0;
const cases = [];
function ok(name, fn) { cases.push({ name, fn }); }

// 1. the committed receipt validates + the verdict is proven.
ok('committed receipt validates (ok + proofOk)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed verdict should be proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. buildReceipt round-trips: a fresh capture -> a receipt that validates with a self-consistent digest.
ok('buildReceipt round-trips from a capture', () => {
  const built = buildReceipt({
    cliNetOnly: { releasedVersion: '0.15.0', releaseTag: 'collab-cli-v0.15.0', retiredCommandsRejected: ['init', 'post', 'poll', 'wait', 'delta'], observedOnVm: "lbabus post -> unknown command (exit 1)" },
    drives: [{ drive: 'x', vm: 'actor', matched: true, frame: { type: 'DONE', task: 't-1', senderId: 'WIN', payload: 'ok' } }],
  });
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.netOnlyDriveProven, true);
});

// 3. FAIL-CLOSED: wrong schema is rejected.
ok('rejects a wrong schema', () => {
  const r = clone(committed); r.schema = 'labview-benchmark-actor/some-other@1'; reseal(r);
  assert.equal(validateReceipt(r).ok, false);
});

// 4. FAIL-CLOSED: a non-WIN sender did not close the loop (semantic guard, digest re-sealed).
ok('rejects a non-WIN reply', () => {
  const r = clone(committed); r.drives[0].frame.senderId = 'LINUX'; reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /did not close the loop/.test(f)), 'expected a loop-closure finding');
});

// 5. FAIL-CLOSED: an unmatched drive did not close the loop (semantic guard, digest re-sealed).
ok('rejects an unmatched drive', () => {
  const r = clone(committed); r.drives[0].matched = false; reseal(r);
  assert.equal(validateReceipt(r).ok, false);
});

// 6. FAIL-CLOSED: an incomplete net-only CLI proof (a retired Discussion command not recorded rejected).
ok('rejects an incomplete net-only CLI proof', () => {
  const r = clone(committed);
  r.cliNetOnly.retiredCommandsRejected = r.cliNetOnly.retiredCommandsRejected.filter((c) => c !== 'post');
  reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /net-only/.test(f) || /retired Discussion command/.test(f)), 'expected a net-only proof finding');
});

// 7. FAIL-CLOSED: a tampered digest is rejected (not re-sealed).
ok('rejects a tampered digest', () => {
  const r = clone(committed); r.digest = '0'.repeat(64);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

for (const c of cases) {
  c.fn();
  n += 1;
  console.log(`ok ${n} - ${c.name}`);
}
console.log(`# net-only-live-drive selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
