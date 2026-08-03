#!/usr/bin/env node
// Self-test for the cross-plane launch-parity verifier (LBA-REQ-072 / ADR-0053). Pure + offline: proves the
// committed receipt validates + is derived from the REAL committed launch trends, and every fail-closed guard
// fires. Gated by `cross-plane-launch-parity`.
// Run: `node experiments/launch-parity/launchParity.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './launchParity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'cross-plane-launch-parity-receipt.json'), 'utf8'));
const linux = JSON.parse(readFileSync(join(here, '..', '..', 'media', 'labview-launch-trend.json'), 'utf8'));
const win = JSON.parse(readFileSync(join(here, '..', '..', 'media', 'labview-launch-trend-win.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. committed receipt validates + parity proven.
ok('committed receipt validates (ok + proofOk)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed parity should be proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. buildReceipt round-trips from the REAL launch trends + equals the committed receipt (grounded in real data).
ok('buildReceipt round-trips from the real launch trends', () => {
  const built = buildReceipt({ linux, win });
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.parityProven, true);
  assert.equal(built.digest, committed.digest, 'the committed receipt is derived from the real committed launch trends');
});

// 3. FAIL-CLOSED: a different workload is a different benchmark (identity mismatch).
ok('rejects a launch-identity mismatch (different workload)', () => {
  const w2 = clone(win); w2.workload = 'labview-other-launch';
  const r = validateReceipt(buildReceipt({ linux, win: w2 }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /identity/.test(f)), 'expected an identity finding');
});

// 4. FAIL-CLOSED: a same-plane pair (both LINUX) is not cross-plane.
ok('rejects a same-plane pair (both LINUX)', () => {
  const r = validateReceipt(buildReceipt({ linux, win: clone(linux) }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /WIN plane/.test(f)), 'expected a WIN-plane finding');
});

// 5. FAIL-CLOSED: a non-workload-trend receipt is rejected.
ok('rejects a non-workload-trend receipt', () => {
  const w2 = clone(win); w2.schema = 'labview-benchmark-actor/something-else@1';
  const r = validateReceipt(buildReceipt({ linux, win: w2 }));
  assert.equal(r.ok, false);
});

// 6. FAIL-CLOSED: a different sample count is a different benchmark (identity mismatch).
ok('rejects a sample-count mismatch (different n)', () => {
  const w2 = clone(win); w2.n = 10;
  const r = validateReceipt(buildReceipt({ linux, win: w2 }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /identity/.test(f)), 'expected an identity finding');
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
console.log(`# cross-plane-launch-parity selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
