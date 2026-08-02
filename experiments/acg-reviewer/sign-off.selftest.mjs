#!/usr/bin/env node
// sign-off.selftest.mjs -- dependency-free self-test for the ACG reviewer sign-off gate (LBA-REQ-027).
// Proves a human sign-off signs/verifies over the exact quorum verdict, that a release publishes ONLY when the
// machine quorum passes AND a recorded enrolled `approve` sign-off accompanies it, and that the gate fails closed
// on a missing / un-enrolled / rejecting / replayed / tampered sign-off or a failing quorum.

import assert from 'node:assert/strict';
import { signReleaseSignOff, verifyReleaseSignOff, gateReleasePublish, generateEnrolledKeypair, REVIEWER_STATIONS } from './sign-off.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const passVerdict = { schema: 'labview-benchmark-actor/acg-quorum-verdict-v1', verdict: 'pass', confidence: 0.9166666666666666, consensus: { sourceCommit: '4df41092' } };
const failVerdict = { schema: 'labview-benchmark-actor/acg-quorum-verdict-v1', verdict: 'fail', confidence: 0.4 };

const alice = generateEnrolledKeypair();
const bob = generateEnrolledKeypair();
const allow = { 'reviewer:alice': alice.publicKeyPem, 'reviewer:bob': bob.publicKeyPem };
const sign = (kp, reviewer, o = {}) => signReleaseSignOff(o.verdict ?? passVerdict, { privateKeyPem: kp.privateKeyPem, reviewer, decision: o.decision ?? 'approve', station: o.station ?? 'LINUX_CODESPACE' });

// 1. sign -> verify round-trip (both stations).
ok('a sign-off signs and verifies (either station)', () => {
  for (const station of REVIEWER_STATIONS) {
    const s = sign(alice, 'reviewer:alice', { station });
    assert.equal(s.station, station);
    assert.equal(verifyReleaseSignOff(passVerdict, s, { reviewerAllowlist: allow }).ok, true);
  }
});

// 2. publish only when the quorum passes AND an enrolled approve sign-off accompanies it.
ok('publish when quorum passes + an enrolled approve sign-off', () => {
  const d = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(alice, 'reviewer:alice')], reviewerAllowlist: allow });
  assert.equal(d.publish, true, d.reasons.join('; '));
  assert.deepEqual(d.approvals, ['reviewer:alice']);
});

// 3. a passing quorum with NO sign-off is BLOCKED (the human gate is un-skippable).
ok('a passing quorum with no sign-off is blocked', () => {
  const d = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [], reviewerAllowlist: allow });
  assert.equal(d.publish, false);
  assert.equal(d.quorumPass, true);
  assert.match(d.reasons.join(' '), /need >= 1 distinct enrolled approving reviewer/);
});

// 4. an un-enrolled reviewer's sign-off does not count.
ok('an un-enrolled reviewer is blocked', () => {
  const rogue = generateEnrolledKeypair();
  const d = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(rogue, 'reviewer:rogue')], reviewerAllowlist: allow });
  assert.equal(d.publish, false);
  assert.match(d.reasons.join(' '), /not enrolled/);
});

// 5. a `reject` decision blocks.
ok('a reject decision blocks', () => {
  const d = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(alice, 'reviewer:alice', { decision: 'reject' })], reviewerAllowlist: allow });
  assert.equal(d.publish, false);
  assert.match(d.reasons.join(' '), /decision is "reject", not approve/);
});

// 6. the sign-off does NOT substitute for the quorum: a failing quorum + a valid approve is still blocked.
ok('a failing quorum is blocked even with an approve sign-off', () => {
  const d = gateReleasePublish({ quorumVerdict: failVerdict, signOffs: [sign(alice, 'reviewer:alice', { verdict: failVerdict })], reviewerAllowlist: allow });
  assert.equal(d.publish, false);
  assert.equal(d.quorumPass, false);
  assert.match(d.reasons.join(' '), /machine quorum verdict is fail/);
});

// 7. a sign-off over a DIFFERENT verdict cannot be replayed (digest-bound).
ok('a sign-off cannot be replayed onto another verdict', () => {
  const overFail = sign(alice, 'reviewer:alice', { verdict: failVerdict });
  const d = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [overFail], reviewerAllowlist: allow });
  assert.equal(d.publish, false);
  assert.match(d.reasons.join(' '), /does not match this quorum verdict/);
});

// 8. a tampered signature fails.
ok('a tampered sign-off signature fails', () => {
  const s = { ...sign(alice, 'reviewer:alice'), signature: Buffer.from('nope').toString('base64') };
  assert.equal(verifyReleaseSignOff(passVerdict, s, { reviewerAllowlist: allow }).ok, false);
});

// 9. an unknown station is rejected (sign throws; verify flags).
ok('an unknown reviewer station is rejected', () => {
  assert.throws(() => signReleaseSignOff(passVerdict, { privateKeyPem: alice.privateKeyPem, reviewer: 'reviewer:alice', station: 'PHONE' }), /station must be one of/);
  const s = { ...sign(alice, 'reviewer:alice'), station: 'PHONE' };
  assert.equal(verifyReleaseSignOff(passVerdict, s, { reviewerAllowlist: allow }).ok, false);
});

// 10. multi-reviewer readiness: minReviewers=2 needs two DISTINCT enrolled approvers.
ok('multi-reviewer quorum requires distinct approvers', () => {
  const two = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(alice, 'reviewer:alice'), sign(bob, 'reviewer:bob')], reviewerAllowlist: allow, minReviewers: 2 });
  assert.equal(two.publish, true, two.reasons.join('; '));
  const one = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(alice, 'reviewer:alice')], reviewerAllowlist: allow, minReviewers: 2 });
  assert.equal(one.publish, false);
  const dup = gateReleasePublish({ quorumVerdict: passVerdict, signOffs: [sign(alice, 'reviewer:alice'), sign(alice, 'reviewer:alice', { station: 'WINDOWS_VM' })], reviewerAllowlist: allow, minReviewers: 2 });
  assert.equal(dup.publish, false); // the same reviewer twice is one distinct approver
});

console.log(`sign-off self-test: ${pass}/${pass} PASS`);
