#!/usr/bin/env node
// Self-test for the signed cross-plane corroboration re-seal (LBA-REQ-089 / ADR-0071). Pure + offline: proves the
// re-seal machinery with a THROWAWAY enrolled key (the real reviewer key stays local + is never in the repo), and
// that every fail-closed guard fires. Reuses the real Ed25519 gate (gateReleasePublish) + quorum (compareWitnesses).
// Gated by `acg-signed-cross-plane-corroboration`.
// Run: `node experiments/acg-quorum/signed-cross-plane-corroboration.selftest.mjs`.

import assert from 'node:assert/strict';
import { buildReceipt, validateReceipt, digestReceipt } from './signed-cross-plane-corroboration.mjs';
import { compareWitnesses } from './compare-witnesses.mjs';
import { generateEnrolledKeypair, signReleaseSignOff } from '../acg-reviewer/sign-off.mjs';

const SERIES = '7ad1c75d08244013d339c3f256fd14220a2df7cea56d5be5b38af2d82d68efaa';
const COMMIT = 'a'.repeat(40);
const clone = (o) => JSON.parse(JSON.stringify(o));
const reseal = (r) => { r.digest = digestReceipt(r); return r; };

const witness = (plane, os, over = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os,
  gate: { verdict: over.verdict ?? 'pass', lbabus: { version: over.version ?? '1.0.0', sourceCommit: over.sourceCommit ?? COMMIT } },
  screenshot: { seriesHash: SERIES, pngSha256: null },
  ubuntu: os === 'linux' ? 'noble' : null,
});
const crossPlaneQuorum = (over = {}) => compareWitnesses([witness('LINUX', 'linux', over), witness('WIN', 'windows', over)]);
const candidateFor = (q) => ({ component: 'extension', version: q.consensus.version, commit: q.consensus.sourceCommit });
const PROV = { workflow: 'selftest', runId: '0' };

// Build a fully-signed re-seal round with a throwaway enrolled reviewer key + optional overrides.
function buildRound({ quorum = crossPlaneQuorum(), candidate, allowlistOverride, corruptSignature = false } = {}) {
  const reviewer = 'reviewer@selftest';
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer, decision: 'approve', station: 'WINDOWS_VM' });
  if (corruptSignature) signOff.signature = Buffer.from('forged').toString('base64');
  const allow = allowlistOverride ?? { [reviewer]: publicKeyPem };
  return buildReceipt({ candidate: candidate ?? candidateFor(quorum), provenance: PROV, quorum, signOffs: [signOff], reviewerAllowlist: allow });
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. a genuine cross-plane quorum + a valid enrolled sign-off => the re-seal is proven.
ok('a signed cross-plane quorum validates (ok + proofOk)', () => {
  const r = buildRound();
  const v = validateReceipt(r);
  assert.equal(v.ok, true, `should validate: ${v.findings.join('; ')}`);
  assert.equal(v.proofOk, true);
  assert.equal(r.verdict.signedCrossPlaneCorroborated, true);
  assert.equal(r.quorum.crossPlane, true);
});

// 2. FAIL CLOSED -- a SINGLE-PLANE quorum (two linux witnesses, the 1.0.0 defect) is not a genuine re-seal.
ok('rejects a single-plane quorum (the 1.0.0 defect)', () => {
  const quorum = compareWitnesses([witness('LINUX', 'linux'), witness('VMWARE', 'linux')]);
  const r = buildRound({ quorum, candidate: candidateFor(quorum) });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /not genuinely cross-plane|would not publish/.test(f)), 'expected a cross-plane / gate finding');
});

// 3. FAIL CLOSED -- a non-pass gate verdict (both planes fail) blocks even though it is cross-plane.
ok('rejects a non-pass quorum verdict', () => {
  const quorum = crossPlaneQuorum({ verdict: 'fail' });
  const r = buildRound({ quorum, candidate: candidateFor(quorum) });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /would not publish/.test(f)), 'expected a machine-gate finding');
});

// 4. FAIL CLOSED -- an UN-ENROLLED reviewer (sign-off key not in the allowlist) cannot corroborate.
ok('rejects an un-enrolled reviewer sign-off', () => {
  const r = buildRound({ allowlistOverride: {} });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /would not publish/.test(f)), 'expected a machine-gate finding');
});

// 5. FAIL CLOSED -- a forged sign-off signature does not verify.
ok('rejects a forged sign-off signature', () => {
  const r = buildRound({ corruptSignature: true });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /would not publish/.test(f)), 'expected a machine-gate finding');
});

// 6. FAIL CLOSED -- the quorum consensus does not name the candidate (commit drift).
ok('rejects a quorum that does not name the candidate', () => {
  const quorum = crossPlaneQuorum();
  const r = buildRound({ quorum, candidate: { component: 'extension', version: '1.0.0', commit: 'f'.repeat(40) } });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /does not name the candidate/.test(f)), 'expected a candidate-binding finding');
});

// 7. FAIL CLOSED -- a tampered digest is rejected (not re-sealed).
ok('rejects a tampered digest', () => {
  const r = clone(buildRound());
  r.digest = '0'.repeat(64);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# signed-cross-plane-corroboration selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
