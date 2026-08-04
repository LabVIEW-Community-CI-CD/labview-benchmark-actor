#!/usr/bin/env node
// Self-test for the cross-plane corroboration attestation (LBA-REQ-088 / ADR-0070). Pure + offline: proves the
// committed genuine attestation validates AND every fail-closed guard fires -- most importantly that a
// SINGLE-PLANE witness set (the shipped 1.0.0 defect: two linux witnesses) is NOT accepted as corroboration.
// Reuses the real os-plane quorum (compare-witnesses.mjs). Gated by `acg-cross-plane-attestation`.
// Run: `node experiments/acg-quorum/cross-plane-attestation.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, digestReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './cross-plane-attestation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'cross-plane-attestation-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reseal = (r) => { r.digest = digestReceipt(r); return r; };
const SERIES = '7ad1c75d08244013d339c3f256fd14220a2df7cea56d5be5b38af2d82d68efaa';

// A witness bundle in the acg-witness-bundle-v1 shape produce-witness.mjs emits.
const witness = (plane, os, over = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os,
  gate: { verdict: over.verdict ?? 'pass', lbabus: { version: over.version ?? '1.0.0', sourceCommit: over.sourceCommit ?? 'a'.repeat(40) } },
  screenshot: { seriesHash: over.seriesHash ?? SERIES, pngSha256: over.pngSha256 ?? null },
  ubuntu: over.ubuntu ?? (os === 'linux' ? 'noble' : null),
  capability: { platform: os === 'windows' ? 'win32-x64' : 'linux-x64' },
});
const PROV = { workflow: 'selftest', runId: '0', commit: 'a'.repeat(40) };

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed genuine attestation validates (ok + proofOk) and is genuinely cross-plane.
ok('committed attestation validates (ok + proofOk + crossPlane)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed attestation should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed attestation should be proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
  assert.equal(committed.verdict.crossPlaneCorroborated, true);
  assert.deepEqual(committed.planes, ['linux', 'windows']);
});

// 2. buildReceipt round-trips a genuine linux + windows pair into a corroborated attestation.
ok('buildReceipt corroborates a genuine linux + windows pair', () => {
  const built = buildReceipt({ provenance: PROV, witnesses: [witness('LINUX-CTX', 'linux'), witness('WIN-CTX', 'windows')] });
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built attestation should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.crossPlaneCorroborated, true);
  assert.equal(built.quorum.crossPlane, true);
});

// 3. FAIL CLOSED -- the shipped 1.0.0 DEFECT: two LINUX witnesses (e.g. LINUX + VMware-Ubuntu) are ONE plane, so
//    they must NOT be accepted as cross-plane corroboration even though every anchor agrees.
ok('rejects a single-plane (two linux) witness set -- the 1.0.0 defect', () => {
  const built = buildReceipt({ provenance: PROV, witnesses: [witness('LINUX', 'linux'), witness('VMWARE', 'linux')] });
  assert.equal(built.verdict.crossPlaneCorroborated, false, 'two linux witnesses must not corroborate cross-plane');
  assert.equal(built.quorum.crossPlane, false);
  const v = validateReceipt(built);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /not cross-plane corroborated/.test(f)), 'expected a single-plane finding');
});

// 4. FAIL CLOSED -- a non-pass gate verdict on either plane withholds corroboration.
ok('rejects a non-pass gate verdict', () => {
  const built = buildReceipt({ provenance: PROV, witnesses: [witness('LINUX', 'linux'), witness('WIN', 'windows', { verdict: 'fail' })] });
  assert.equal(built.verdict.crossPlaneCorroborated, false);
  const v = validateReceipt(built);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /not cross-plane corroborated/.test(f)), 'expected a withheld-verdict finding');
});

// 5. FAIL CLOSED -- a witness anchor is tampered without re-deriving the quorum (digest re-sealed): the committed
//    quorum no longer re-derives from the embedded witnesses.
ok('rejects a tampered witness (quorum no longer re-derives)', () => {
  const r = clone(committed);
  r.witnesses[1].gate.lbabus.sourceCommit = 'f'.repeat(40); // diverge the windows witness commit
  reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /does not re-derive|not cross-plane corroborated/.test(f)), 'expected a re-derivation/verdict finding');
});

// 6. FAIL CLOSED -- a forged verdict (claims corroborated over a single-plane set, digest re-sealed).
ok('rejects a forged corroborated verdict over a single-plane set', () => {
  const r = buildReceipt({ provenance: PROV, witnesses: [witness('LINUX', 'linux'), witness('CODESPACE', 'linux')] });
  r.verdict.crossPlaneCorroborated = true; // the lie
  reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /contradicts the rule|not cross-plane corroborated/.test(f)), 'expected a forged-verdict finding');
});

// 7. FAIL CLOSED -- a tampered digest is rejected (not re-sealed).
ok('rejects a tampered digest', () => {
  const r = clone(committed);
  r.digest = '0'.repeat(64);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# cross-plane-attestation selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
