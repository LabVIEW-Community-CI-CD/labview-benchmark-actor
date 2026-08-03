#!/usr/bin/env node
// reviewerVerdict.selftest.mjs -- deterministic self-test for the reviewer VISUAL VERDICT beacon
// (LBA-REQ-057, ADR-0037). No VM: synthetic candidate + an enrolled Ed25519 reviewer key.
// Run: node experiments/handoff-beacon/reviewerVerdict.selftest.mjs

import assert from 'node:assert/strict';
import {
  REVIEWER_VERDICT_SCHEMA,
  SIGNOFF_SCHEMA,
  buildReviewerVerdict,
  validateReviewerVerdict,
  reviewerVerdictDigest,
  signReviewerVerdict,
  verifyReviewerVerdict,
  gateVisualReview,
  generateEnrolledKeypair,
} from './reviewerVerdict.mjs';
import { gateReleaseWithReview } from './release-with-review.mjs';
import { signReleaseSignOff } from '../acg-reviewer/sign-off.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const target = { component: 'extension', version: '0.5.0', commit: 'a'.repeat(40), vsixSha256: 'b'.repeat(64) };
const evidence = [{ kind: 'capture', ref: 'run-1785741430959' }, { kind: 'frame', ref: 'peak 568/1969 @ 767 MB/s' }];

// Enroll a reviewer keypair (the private key stays with the reviewer; the public key is enrolled).
const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
const reviewer = 'sergio@vi-tech.nl';
const allowlist = { [reviewer]: publicKeyPem };

ok('buildReviewerVerdict builds a reviewer-verdict@1 with target + evidence + defaults', () => {
  const v = buildReviewerVerdict({ target, verdict: 'pass', reviewer, station: 'WINDOWS_VM', notes: 'looks right', evidence, renderedAt: '2026-08-03T00:00:00Z' });
  assert.equal(v.schema, REVIEWER_VERDICT_SCHEMA);
  assert.equal(v.verdict, 'pass');
  assert.equal(v.target.version, '0.5.0');
  assert.equal(v.station, 'WINDOWS_VM');
  assert.equal(v.evidence.length, 2);
  assert.equal(buildReviewerVerdict({}).verdict, 'fail');          // default verdict is fail (conservative)
  assert.equal(buildReviewerVerdict({}).station, 'WINDOWS_VM');     // default station
  assert.equal(buildReviewerVerdict({ verdict: 'nope' }).verdict, 'fail'); // unknown verdict -> fail
  assert.deepEqual(buildReviewerVerdict({ evidence: [{ kind: 'x' }] }).evidence, []); // evidence w/o ref dropped
});

ok('validateReviewerVerdict admits a good verdict + fails closed', () => {
  const v = buildReviewerVerdict({ target, verdict: 'pass', reviewer });
  assert.equal(validateReviewerVerdict(v).ok, true);
  assert.equal(validateReviewerVerdict({ ...v, schema: 'nope' }).ok, false);
  assert.equal(validateReviewerVerdict({ ...v, verdict: 'bogus' }).ok, false);
  assert.equal(validateReviewerVerdict({ ...v, target: { version: '', commit: '' } }).ok, false);
  assert.equal(validateReviewerVerdict({ ...v, reviewer: '' }).ok, false);
  assert.equal(validateReviewerVerdict({ ...v, station: 'MARS' }).ok, false);
  assert.equal(validateReviewerVerdict(null).ok, false);
});

ok('signReviewerVerdict produces an acg-human-signoff-v1 bound to the verdict digest', () => {
  const v = buildReviewerVerdict({ target, verdict: 'pass', reviewer, evidence });
  const s = signReviewerVerdict(v, { privateKeyPem, reviewer, station: 'WINDOWS_VM' });
  assert.equal(s.schema, SIGNOFF_SCHEMA);
  assert.equal(s.decision, 'approve');                             // pass -> approve
  assert.equal(s.subject.verdictDigest, reviewerVerdictDigest(v));
  assert.equal(s.algorithm, 'ed25519');
  assert.equal(signReviewerVerdict(buildReviewerVerdict({ target, verdict: 'fail', reviewer }), { privateKeyPem, reviewer }).decision, 'reject');
  assert.throws(() => signReviewerVerdict(v, { reviewer }), /privateKeyPem/);
  assert.throws(() => signReviewerVerdict(v, { privateKeyPem }), /reviewer/);
  assert.throws(() => signReviewerVerdict(v, { privateKeyPem, reviewer, station: 'MARS' }), /station/);
});

ok('verifyReviewerVerdict verifies a good sign-off + fails closed on tampering', () => {
  const v = buildReviewerVerdict({ target, verdict: 'pass', reviewer, evidence });
  const s = signReviewerVerdict(v, { privateKeyPem, reviewer });
  assert.equal(verifyReviewerVerdict(v, s, { reviewerAllowlist: allowlist }).ok, true);
  // a tampered verdict (different notes) no longer matches the signed digest
  const tampered = { ...v, notes: 'tampered' };
  assert.equal(verifyReviewerVerdict(tampered, s, { reviewerAllowlist: allowlist }).ok, false);
  // an un-enrolled reviewer
  assert.equal(verifyReviewerVerdict(v, s, { reviewerAllowlist: {} }).ok, false);
  // a key that does not match the enrolled one
  const other = generateEnrolledKeypair();
  assert.equal(verifyReviewerVerdict(v, s, { reviewerAllowlist: { [reviewer]: other.publicKeyPem } }).ok, false);
  // a forged signature
  assert.equal(verifyReviewerVerdict(v, { ...s, signature: Buffer.from('forged').toString('base64') }, { reviewerAllowlist: allowlist }).ok, false);
  assert.equal(verifyReviewerVerdict(v, { schema: 'nope' }, { reviewerAllowlist: allowlist }).ok, false);
});

ok('gateVisualReview publishes only on a pass verdict + enough verified enrolled approvals', () => {
  const passV = buildReviewerVerdict({ target, verdict: 'pass', reviewer, evidence });
  const s = signReviewerVerdict(passV, { privateKeyPem, reviewer });
  const okDecision = gateVisualReview({ verdict: passV, signOffs: [s], reviewerAllowlist: allowlist, minReviewers: 1 });
  assert.equal(okDecision.publish, true);
  assert.deepEqual(okDecision.approvals, [reviewer]);
  // a 'changes' verdict does not publish even with a valid sign-off over it
  const changesV = buildReviewerVerdict({ target, verdict: 'changes', reviewer });
  const sc = signReviewerVerdict(changesV, { privateKeyPem, reviewer });
  assert.equal(gateVisualReview({ verdict: changesV, signOffs: [sc], reviewerAllowlist: allowlist }).publish, false);
  // a pass verdict with NO sign-off does not publish
  assert.equal(gateVisualReview({ verdict: passV, signOffs: [], reviewerAllowlist: allowlist }).publish, false);
  // requiring 2 reviewers but only 1 enrolled approval -> no publish
  assert.equal(gateVisualReview({ verdict: passV, signOffs: [s], reviewerAllowlist: allowlist, minReviewers: 2 }).publish, false);
  // an un-enrolled signer does not count
  const rogue = generateEnrolledKeypair();
  const sr = signReviewerVerdict(passV, { privateKeyPem: rogue.privateKeyPem, reviewer: 'rogue' });
  assert.equal(gateVisualReview({ verdict: passV, signOffs: [sr], reviewerAllowlist: allowlist }).publish, false);
});

ok('gateReleaseWithReview requires BOTH the machine release gate + the visual review', () => {
  const passV = buildReviewerVerdict({ target, verdict: 'pass', reviewer, evidence });
  const vs = signReviewerVerdict(passV, { privateKeyPem, reviewer });
  const quorumVerdict = { schema: 'labview-benchmark-actor/acg-quorum', verdict: 'pass', n: 2 };
  const qs = signReleaseSignOff(quorumVerdict, { privateKeyPem, reviewer, decision: 'approve', station: 'WINDOWS_VM' });
  assert.equal(gateReleaseWithReview({ quorumVerdict, quorumSignOffs: [qs], verdict: passV, verdictSignOffs: [vs], reviewerAllowlist: allowlist }).publish, true);
  // visual missing -> composed fails even though the machine gate passes
  assert.equal(gateReleaseWithReview({ quorumVerdict, quorumSignOffs: [qs], verdict: passV, verdictSignOffs: [], reviewerAllowlist: allowlist }).publish, false);
  // machine quorum not pass -> composed fails even though the visual review passes
  assert.equal(gateReleaseWithReview({ quorumVerdict: { verdict: 'fail' }, quorumSignOffs: [], verdict: passV, verdictSignOffs: [vs], reviewerAllowlist: allowlist }).publish, false);
});

console.log(`reviewer-verdict self-test: ${pass}/${pass} PASS`);
