#!/usr/bin/env node
// Self-test for the release-with-review-drive receipt verifier (LBA-REQ-069 / ADR-0050). Pure + offline: proves
// the committed receipt validates AND every fail-closed binding guard fires. Reuses the real Ed25519 verdict
// signing primitives (reviewerVerdict.mjs) for the round-trip case. Gated by `release-with-review-drive`.
// Run: `node reviewer-workstation/release-with-review-drive.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, digestReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './release-with-review-drive.mjs';
import { generateEnrolledKeypair, buildReviewerVerdict, signReviewerVerdict } from '../experiments/handoff-beacon/reviewerVerdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'release-with-review-drive-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reseal = (r) => { r.digest = digestReceipt(r); return r; };

// Build a fresh, fully-signed round for the positive round-trip + as a clean mutation base.
function freshRound() {
  const reviewer = 'reviewer@selftest';
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const candidate = { component: 'extension', version: '9.9.9', commit: 'c'.repeat(40), vsixSha256: 'd'.repeat(64) };
  const verdict = buildReviewerVerdict({ target: candidate, verdict: 'pass', reviewer, station: 'WINDOWS_VM', evidence: [{ kind: 'capture', ref: 'run-x' }], renderedAt: '2026-08-03T00:00:00Z' });
  const signOff = signReviewerVerdict(verdict, { privateKeyPem, reviewer });
  return buildReceipt({
    candidate,
    staged: { drive: 'stage', vm: 'actor', matched: true, candidate: { component: 'extension', version: '9.9.9' }, frame: { type: 'DONE', task: 'rev-x', senderId: 'WIN', payload: 'ext 9.9.9 staged; review OK' } },
    review: { verdict, signOff },
    reviewerAllowlist: { [reviewer]: publicKeyPem },
    minVisualReviewers: 1,
  });
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. committed receipt validates + verdict proven.
ok('committed receipt validates (ok + proofOk)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed verdict should be proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. buildReceipt round-trips from a freshly-signed round.
ok('buildReceipt round-trips a signed round', () => {
  const built = freshRound();
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.releaseWithReviewProven, true);
});

// 3. FAIL-CLOSED: the human signed a DIFFERENT candidate than the one staged (binding break).
ok('rejects a candidate<->verdict-target mismatch', () => {
  const r = clone(committed); r.candidate.commit = 'f'.repeat(40); reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /does not match the staged release candidate/.test(f)), 'expected a candidate-binding finding');
});

// 4. FAIL-CLOSED: a forged sign-off signature does not verify.
ok('rejects a forged sign-off signature', () => {
  const r = clone(committed); r.review.signOff.signature = Buffer.from('forged').toString('base64'); reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /sign-off does not verify/.test(f)), 'expected a sign-off verification finding');
});

// 5. FAIL-CLOSED: the candidate was not staged over net (a non-WIN staging frame).
ok('rejects staging that did not close the loop over net', () => {
  const r = clone(committed); r.staged.frame.senderId = 'LINUX'; reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /staged over net/.test(f)), 'expected a staging finding');
});

// 6. FAIL-CLOSED: the net announce was not correctly derived from the signed verdict.
ok('rejects a mis-derived net announce', () => {
  const r = clone(committed); r.announce.task = 'extension-release-0.0.0'; r.announce.frame.task = 'extension-release-0.0.0'; reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /announce is not correctly derived/.test(f)), 'expected an announce-derivation finding');
});

// 7. FAIL-CLOSED: a tampered digest is rejected (not re-sealed).
ok('rejects a tampered digest', () => {
  const r = clone(committed); r.digest = '0'.repeat(64);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /digest/.test(f)), 'expected a digest finding');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# release-with-review-drive selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
