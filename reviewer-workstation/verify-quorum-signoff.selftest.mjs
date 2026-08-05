#!/usr/bin/env node
// Self-test for the host-side quorum sign-off verifier (#415, LBA-REQ-089). Pure + offline: proves a genuine
// enrolled sign-off over a passing cross-plane quorum verifies, AND every fail-closed guard fires (forged
// signature, un-enrolled reviewer, wrong quorum, non-pass quorum, single-plane quorum). Reuses the REAL Ed25519
// sign-off primitives with a THROWAWAY enrolled key (no committed private material). Gated by `verify-quorum-signoff`.
// Run: `node reviewer-workstation/verify-quorum-signoff.selftest.mjs`.

import assert from 'node:assert/strict';
import { verifyQuorumSignOff } from './verify-quorum-signoff.mjs';
import { generateEnrolledKeypair, signReleaseSignOff } from '../experiments/acg-reviewer/sign-off.mjs';

// A genuine, passing, cross-plane quorum verdict (the shape sign-release-quorum.mjs signs the bundleDigest of).
function crossPlaneQuorum(overrides = {}) {
  return {
    schema: 'labview-benchmark-actor/acg-quorum-verdict-v2',
    verdict: 'pass',
    crossPlane: true,
    confidence: 0.94,
    consensus: { version: '1.2.0', sourceCommit: 'c'.repeat(40), verdict: 'pass' },
    ...overrides,
  };
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. HAPPY PATH: an enrolled sign-off over a passing cross-plane quorum verifies.
ok('a genuine enrolled sign-off over a passing cross-plane quorum verifies', () => {
  const quorum = crossPlaneQuorum();
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  const r = verifyQuorumSignOff({ attestationDoc: quorum, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, true, `should verify: ${r.reasons.join('; ')}`);
  assert.equal(r.crossPlane, true);
  assert.equal(r.verdict, 'pass');
});

// 2. Accepts an ATTESTATION wrapper ({ quorum }) as well as a bare quorum (quorumFromDoc unwrap).
ok('accepts a cross-plane-attestation wrapper ({ quorum }) via quorumFromDoc', () => {
  const quorum = crossPlaneQuorum();
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  const attestationDoc = { schema: 'labview-benchmark-actor/cross-plane-corroboration-attestation@1', quorum };
  const r = verifyQuorumSignOff({ attestationDoc, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, true, `should verify through the wrapper: ${r.reasons.join('; ')}`);
});

// 3. FAIL-CLOSED: a forged signature does not verify.
ok('rejects a forged signature', () => {
  const quorum = crossPlaneQuorum();
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  signOff.signature = Buffer.from('forged').toString('base64');
  const r = verifyQuorumSignOff({ attestationDoc: quorum, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /signature does not verify/.test(x)), 'expected a signature finding');
});

// 4. FAIL-CLOSED: an un-enrolled reviewer (empty allowlist) is rejected.
ok('rejects an un-enrolled reviewer', () => {
  const quorum = crossPlaneQuorum();
  const { privateKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'stranger@example.com', station: 'WINDOWS_VM' });
  const r = verifyQuorumSignOff({ attestationDoc: quorum, signOff, reviewerAllowlist: {} });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /not enrolled/.test(x)), 'expected an enrollment finding');
});

// 5. FAIL-CLOSED: a sign-off over a DIFFERENT quorum does not match this attestation (digest mismatch).
ok('rejects a sign-off bound to a different quorum', () => {
  const signed = crossPlaneQuorum({ consensus: { version: '1.2.0', sourceCommit: 'c'.repeat(40), verdict: 'pass' } });
  const other = crossPlaneQuorum({ consensus: { version: '9.9.9', sourceCommit: 'd'.repeat(40), verdict: 'pass' } });
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(signed, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  const r = verifyQuorumSignOff({ attestationDoc: other, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /does not match this quorum/.test(x)), 'expected a digest-mismatch finding');
});

// 6. FAIL-CLOSED: a non-pass quorum is rejected even with a valid signature (the sign-off does not launder a fail).
ok('rejects a valid signature over a non-pass quorum', () => {
  const quorum = crossPlaneQuorum({ verdict: 'fail' });
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  const r = verifyQuorumSignOff({ attestationDoc: quorum, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /not pass/.test(x)), 'expected a non-pass finding');
});

// 7. FAIL-CLOSED: a single-plane quorum is rejected even with a valid signature (the shipped 1.0.0 defect).
ok('rejects a valid signature over a single-plane quorum', () => {
  const quorum = crossPlaneQuorum({ crossPlane: false });
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: 'reviewer@selftest', station: 'WINDOWS_VM' });
  const r = verifyQuorumSignOff({ attestationDoc: quorum, signOff, reviewerAllowlist: { 'reviewer@selftest': publicKeyPem } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /not cross-plane/.test(x)), 'expected a cross-plane finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# verify-quorum-signoff selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
