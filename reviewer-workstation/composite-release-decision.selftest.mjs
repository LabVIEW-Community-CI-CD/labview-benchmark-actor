#!/usr/bin/env node
// Self-test for the composite-release-decision verifier (LBA-REQ-070 / ADR-0051). Pure + offline: proves the
// committed receipt validates AND every fail-closed guard fires. Reuses the real Ed25519 machine + visual
// signing primitives. Gated by `composite-release-decision`.
// Run: `node reviewer-workstation/composite-release-decision.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, digestReceipt, RECEIPT_SCHEMA, REQUIREMENT } from './composite-release-decision.mjs';
import { generateEnrolledKeypair, buildReviewerVerdict, signReviewerVerdict } from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import { signReleaseSignOff } from '../experiments/acg-reviewer/sign-off.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'composite-release-decision-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reseal = (r) => { r.digest = digestReceipt(r); return r; };
const STAGED = { drive: 'stage', vm: 'actor', matched: true, candidate: { component: 'extension', version: '9.9.9' }, frame: { type: 'DONE', task: 'rev-x', senderId: 'WIN', payload: 'ext 9.9.9 staged; review OK' } };

// Build a fully-signed composite round (both gates pass, bound to one candidate) with optional overrides.
function buildRound({ consensusVersion, verdictTargetCommit, quorumVerdictValue = 'pass' } = {}) {
  const reviewer = 'reviewer@selftest';
  const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
  const candidate = { component: 'extension', version: '9.9.9', commit: 'c'.repeat(40), vsixSha256: 'd'.repeat(64) };
  const quorumVerdict = {
    schema: 'labview-benchmark-actor/acg-quorum-verdict-v1',
    verdict: quorumVerdictValue,
    confidence: 0.95,
    consensus: { version: consensusVersion ?? candidate.version, sourceCommit: candidate.commit, verdict: quorumVerdictValue },
  };
  const machineSignOff = signReleaseSignOff(quorumVerdict, { privateKeyPem, reviewer, decision: 'approve', station: 'WINDOWS_VM' });
  const target = { ...candidate, commit: verdictTargetCommit ?? candidate.commit };
  const verdict = buildReviewerVerdict({ target, verdict: 'pass', reviewer, station: 'WINDOWS_VM', renderedAt: '2026-08-03T00:00:00Z' });
  const signOff = signReviewerVerdict(verdict, { privateKeyPem, reviewer });
  return buildReceipt({
    candidate,
    staged: STAGED,
    machine: { quorumVerdict, signOffs: [machineSignOff] },
    visual: { verdict, signOff },
    reviewerAllowlist: { [reviewer]: publicKeyPem },
    minReviewers: 1,
    minVisualReviewers: 1,
  });
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. committed receipt validates + composite verdict proven.
ok('committed receipt validates (ok + proofOk)', () => {
  const r = validateReceipt(committed);
  assert.equal(r.ok, true, `committed receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed composite decision should be proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. buildReceipt round-trips a fully-signed composite round (both gates + all bindings).
ok('buildReceipt round-trips a signed composite round', () => {
  const built = buildRound();
  const r = validateReceipt(built);
  assert.equal(r.ok, true, `built receipt should validate: ${r.findings.join('; ')}`);
  assert.equal(built.verdict.compositeReleaseProven, true);
});

// 3. FAIL-CLOSED: the machine quorum consensus does not name the staged candidate (version drift, re-signed).
ok('rejects a machine consensus not bound to the candidate', () => {
  const r = buildRound({ consensusVersion: '0.0.0' });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /machine quorum consensus/.test(f)), 'expected a machine-consensus-binding finding');
});

// 4. FAIL-CLOSED: the human visual verdict target does not name the staged candidate (commit drift, re-signed).
ok('rejects a visual target not bound to the candidate', () => {
  const r = buildRound({ verdictTargetCommit: 'f'.repeat(40) });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /visual verdict target does not name/.test(f)), 'expected a visual-target-binding finding');
});

// 5. FAIL-CLOSED: a failing machine quorum blocks (the machine gate is un-skippable).
ok('rejects a failing machine quorum', () => {
  const r = buildRound({ quorumVerdictValue: 'fail' });
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /machine corroboration gate would not publish/.test(f)), 'expected a machine-gate finding');
});

// 6. FAIL-CLOSED: a forged visual sign-off blocks the human gate.
ok('rejects a forged visual sign-off', () => {
  const r = clone(committed); r.visual.signOff.signature = Buffer.from('forged').toString('base64'); reseal(r);
  const v = validateReceipt(r);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => /human visual gate would not publish/.test(f)), 'expected a visual-gate finding');
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
console.log(`# composite-release-decision selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
