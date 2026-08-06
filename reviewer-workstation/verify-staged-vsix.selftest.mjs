#!/usr/bin/env node
// Self-test for the staged-candidate SHA guard (#411, LBA-REQ-057). Pure + offline: proves a matching staged
// .vsix passes and every fail-closed guard fires (mismatch, non-hex, missing, short). Also proves the candidate
// sha is resolved from a verdict request/record target. Gated by `verify-staged-vsix`.
// Run: `node reviewer-workstation/verify-staged-vsix.selftest.mjs`.

import assert from 'node:assert/strict';
import { stagedVsixMatches, candidateShaFrom } from './verify-staged-vsix.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. HAPPY PATH: identical shas match (case-insensitive).
ok('a staged .vsix whose sha equals the candidate passes (case-insensitive)', () => {
  const r = stagedVsixMatches({ candidateSha256: SHA_A.toUpperCase(), stagedSha256: SHA_A });
  assert.equal(r.ok, true, `should match: ${r.reasons.join('; ')}`);
});

// 2. FAIL-CLOSED: different shas are rejected as reviewed!=shipped.
ok('a staged .vsix whose sha differs from the candidate fails closed (reviewed!=shipped)', () => {
  const r = stagedVsixMatches({ candidateSha256: SHA_A, stagedSha256: SHA_B });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /DIFFERENT build|reviewed!=shipped/.test(x)), 'expected a reviewed!=shipped finding');
});

// 3. FAIL-CLOSED: a non-hex / wrong-length digest is rejected (defensive against a garbage CertUtil parse).
ok('a non-hex or wrong-length staged sha is rejected', () => {
  assert.equal(stagedVsixMatches({ candidateSha256: SHA_A, stagedSha256: 'not-a-hash' }).ok, false);
  assert.equal(stagedVsixMatches({ candidateSha256: SHA_A, stagedSha256: 'abcd' }).ok, false);
  assert.equal(stagedVsixMatches({ candidateSha256: 'zz' + 'a'.repeat(62), stagedSha256: SHA_A }).ok, false);
});

// 4. FAIL-CLOSED: a missing sha (empty / undefined) is rejected, never silently passes.
ok('a missing candidate or staged sha fails closed', () => {
  assert.equal(stagedVsixMatches({ candidateSha256: '', stagedSha256: SHA_A }).ok, false);
  assert.equal(stagedVsixMatches({ candidateSha256: SHA_A }).ok, false);
  assert.equal(stagedVsixMatches({}).ok, false);
});

// 5. candidateShaFrom resolves the candidate sha from a verdict REQUEST target.
ok('candidateShaFrom reads target.vsixSha256 from a verdict request', () => {
  const req = { target: { component: 'extension', version: '1.2.0', commit: 'c'.repeat(40), vsixSha256: SHA_A } };
  assert.equal(candidateShaFrom({ requestDoc: req }), SHA_A);
});

// 6. candidateShaFrom resolves from a signed RECORD ({ verdict:{ target }}) and prefers an explicit value.
ok('candidateShaFrom reads a signed record + prefers an explicit --candidate-sha256', () => {
  const record = { verdict: { target: { vsixSha256: SHA_A } }, signOff: {} };
  assert.equal(candidateShaFrom({ requestDoc: record }), SHA_A);
  assert.equal(candidateShaFrom({ candidateSha256: SHA_B, requestDoc: record }), SHA_B);
});

// 7. end-to-end: resolve from a request then compare against a matching / mismatching staged sha.
ok('request-target sha compared against a matching then mismatching staged sha', () => {
  const req = { target: { vsixSha256: SHA_A } };
  const cand = candidateShaFrom({ requestDoc: req });
  assert.equal(stagedVsixMatches({ candidateSha256: cand, stagedSha256: SHA_A }).ok, true);
  assert.equal(stagedVsixMatches({ candidateSha256: cand, stagedSha256: SHA_B }).ok, false);
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# verify-staged-vsix selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
