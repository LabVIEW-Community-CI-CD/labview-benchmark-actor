#!/usr/bin/env node
// Self-test for the composite receipt assembler (issue #410, LBA-REQ-070 / ADR-0051). Pure + offline: proves the
// assembler produces a receipt that passes the composite verifier from correctly-bound pieces, AND fails closed
// with a PRECISE per-field diff when any piece (visual target / machine consensus / staged frame) names a
// different candidate. Reuses the committed receipt as the matching fixture. Gated by `assemble-composite`.
// Run: `node reviewer-workstation/assemble-composite.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleComposite, computeBindingDiffs } from './assemble-composite.mjs';
import { validateReceipt } from './composite-release-decision.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'composite-release-decision-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// Reconstruct the four assembler INPUT pieces from the committed (matching) receipt.
function piecesFromCommitted() {
  return {
    candidate: clone(committed.candidate),
    machine: clone(committed.machine),
    visual: clone(committed.visual),
    staged: clone(committed.staged),
    reviewerAllowlist: clone(committed.reviewerAllowlist),
    minReviewers: committed.gate?.minReviewers ?? 1,
    minVisualReviewers: committed.gate?.minVisualReviewers ?? 1,
  };
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. HAPPY PATH: correctly-bound pieces assemble into a receipt that passes the composite verifier.
ok('assembles a valid composite receipt from correctly-bound pieces', () => {
  const res = assembleComposite(piecesFromCommitted());
  assert.equal(res.ok, true, `assembler should succeed: ${res.findings.join('; ')}`);
  assert.equal(res.proofOk, true, 'the assembled composite decision should be proven');
  assert.equal(res.diffs.length, 0, 'no binding diffs for a matched set');
  const v = validateReceipt(res.receipt);
  assert.equal(v.ok, true, `the assembled receipt should pass the composite verifier: ${v.findings.join('; ')}`);
  assert.equal(res.receipt.candidate.version, committed.candidate.version);
});

// 2. FAIL-CLOSED (precise diff): the VISUAL verdict target names a different commit than the candidate.
ok('rejects a visual target that names a different candidate, with a precise diff', () => {
  const p = piecesFromCommitted();
  p.visual.verdict.target.commit = 'f'.repeat(40);
  const res = assembleComposite(p);
  assert.equal(res.ok, false);
  assert.equal(res.receipt, null, 'no receipt is built when the binding fails');
  const d = res.diffs.find((x) => x.source === 'visual.verdict.target' && x.field === 'commit');
  assert.ok(d, 'expected a precise visual.verdict.target.commit diff');
  assert.equal(d.expected, committed.candidate.commit);
  assert.equal(d.got, 'f'.repeat(40));
});

// 3. FAIL-CLOSED (precise diff): the MACHINE quorum consensus names a different version than the candidate.
ok('rejects a machine consensus that names a different candidate, with a precise diff', () => {
  const p = piecesFromCommitted();
  p.machine.quorumVerdict.consensus.version = '0.0.0';
  const res = assembleComposite(p);
  assert.equal(res.ok, false);
  const d = res.diffs.find((x) => x.source === 'machine.quorumVerdict.consensus' && x.field === 'version');
  assert.ok(d, 'expected a precise machine consensus version diff');
  assert.equal(d.expected, committed.candidate.version);
  assert.equal(d.got, '0.0.0');
});

// 4. FAIL-CLOSED (precise diff): the STAGED frame reports a different version than the candidate.
ok('rejects a staged candidate that names a different version, with a precise diff', () => {
  const p = piecesFromCommitted();
  p.staged.candidate.version = '7.7.7';
  const res = assembleComposite(p);
  assert.equal(res.ok, false);
  const d = res.diffs.find((x) => x.source === 'staged.candidate' && x.field === 'version');
  assert.ok(d, 'expected a precise staged.candidate.version diff');
  assert.equal(d.got, '7.7.7');
});

// 5. computeBindingDiffs is empty for the matched committed set (the binding invariant holds as committed).
ok('computeBindingDiffs is empty for the matched committed set', () => {
  const diffs = computeBindingDiffs(piecesFromCommitted());
  assert.equal(diffs.length, 0, `committed set should have no binding diffs, got: ${JSON.stringify(diffs)}`);
});

// 6. FAIL-CLOSED: even with a perfect candidate binding, a tampered visual sign-off fails the composite gate
//    (the assembler defers the cryptographic gate to the composite verifier -- it does not paper over it).
ok('a bound-but-forged visual sign-off still fails the composite gate', () => {
  const p = piecesFromCommitted();
  p.visual.signOff.signature = Buffer.from('forged').toString('base64');
  const res = assembleComposite(p);
  assert.equal(res.ok, false, 'a forged sign-off must not pass');
  assert.equal(res.diffs.length, 0, 'the candidate binding still holds (the failure is the gate, not the binding)');
  assert.ok(res.findings.some((f) => /human visual gate would not publish/.test(f)), 'expected the composite gate finding');
});

// 7. FAIL-CLOSED: multiple pieces drift at once -> every mismatch is reported (not just the first).
ok('reports every binding mismatch when multiple pieces drift', () => {
  const p = piecesFromCommitted();
  p.visual.verdict.target.vsixSha256 = 'a'.repeat(64);
  p.machine.quorumVerdict.consensus.sourceCommit = 'b'.repeat(40);
  const res = assembleComposite(p);
  assert.equal(res.ok, false);
  assert.ok(res.diffs.some((x) => x.source === 'visual.verdict.target' && x.field === 'vsixSha256'), 'visual vsix diff reported');
  assert.ok(res.diffs.some((x) => x.source === 'machine.quorumVerdict.consensus' && x.field === 'sourceCommit'), 'machine commit diff reported');
  assert.ok(res.diffs.length >= 2, 'both mismatches are surfaced together');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# assemble-composite selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
