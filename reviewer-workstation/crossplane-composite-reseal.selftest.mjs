#!/usr/bin/env node
// Self-test for the genuine cross-plane composite RE-SEAL (LBA-REQ-090 / ADR-0072). Pure + offline: proves the
// committed crossPlane composite validates as a PROVEN composite release decision AND its machine quorum is
// genuinely cross-plane -- the corrected counterpart of the shipped single-plane composite-release-decision-receipt.json
// (the flagged 1.0.0 defect), which validates as a composite but is NOT cross-plane. Reuses the real composite
// verifier (composite-release-decision.mjs). Gated by `acg-crossplane-composite-reseal`.
// Run: `node reviewer-workstation/crossplane-composite-reseal.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReceipt } from './composite-release-decision.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crossplane = JSON.parse(readFileSync(join(here, 'composite-release-decision-crossplane-receipt.json'), 'utf8'));
const frozen = JSON.parse(readFileSync(join(here, 'composite-release-decision-receipt.json'), 'utf8'));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed crossPlane composite validates as a PROVEN composite release decision.
ok('crossPlane composite validates (ok + proofOk + proven)', () => {
  const v = validateReceipt(crossplane);
  assert.equal(v.ok, true, `should validate: ${v.findings.join('; ')}`);
  assert.equal(v.proofOk, true);
  assert.equal(crossplane.verdict.compositeReleaseProven, true);
});

// 2. its MACHINE gate is the genuine two-plane quorum (spans both os-planes).
ok('machine quorum is genuinely cross-plane', () => {
  assert.equal(crossplane.machine.quorumVerdict.crossPlane, true, 'the re-seal quorum must be crossPlane');
  assert.equal(crossplane.machine.quorumVerdict.verdict, 'pass');
});

// 3. both gates are enrolled-signed + bound to ONE candidate (all five bindings hold).
ok('machine + human gates bind to one candidate (all 5 bindings)', () => {
  for (const k of ['machinePublish', 'visualPublish', 'stagedOverNet', 'visualTargetBound', 'machineConsensusBound']) {
    assert.equal(crossplane.binding[k], true, `binding ${k} must hold`);
  }
  assert.equal(crossplane.candidate.commit, crossplane.machine.quorumVerdict.consensus.sourceCommit, 'quorum names the candidate commit');
  assert.equal(crossplane.candidate.vsixSha256, crossplane.visual.verdict.target.vsixSha256, 'visual target names the candidate vsix');
});

// 4. CONTRAST -- the shipped composite validates as a composite BUT is NOT cross-plane: the single-plane defect
//    this re-seal corrects (its quorum spanned LINUX + a VMware-Ubuntu witness, both the linux plane).
ok('the shipped composite is single-plane (the defect the re-seal corrects)', () => {
  assert.notEqual(frozen.machine.quorumVerdict.crossPlane, true, 'the shipped composite quorum must NOT be crossPlane');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# crossplane-composite-reseal selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
