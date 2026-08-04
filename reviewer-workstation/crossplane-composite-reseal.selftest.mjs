#!/usr/bin/env node
// Self-test for the genuine cross-plane composite RE-SEAL + enforcement (LBA-REQ-090 / ADR-0072; enforce+collapse
// ADR-0073). Pure + offline: proves the committed 1.0.0 composite (composite-release-decision-receipt.json, collapsed
// to the genuine crossPlane re-seal) validates as a PROVEN composite release decision, its machine quorum is
// genuinely cross-plane, and verify-composite-release CLEARS it while a single-plane variant is REJECTED fail-closed.
// Reuses the real composite verifier + the release enforcement. Gated by `acg-crossplane-composite-reseal`.
// Run: `node reviewer-workstation/crossplane-composite-reseal.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReceipt } from './composite-release-decision.mjs';
import { verifyCompositeRelease } from '../tools/collab-cli/verify-composite-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crossplane = JSON.parse(readFileSync(join(here, 'composite-release-decision-receipt.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

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

// 4. the release enforcement CLEARS the collapsed crossPlane composite for extension 1.0.0.
ok('verify-composite-release clears the crossPlane 1.0.0 composite', () => {
  const d = verifyCompositeRelease({ receipt: crossplane, component: 'extension', version: '1.0.0' });
  assert.equal(d.publish, true, `should clear: ${d.reasons.join('; ')}`);
});

// 5. FAIL CLOSED -- a SINGLE-PLANE composite (the shipped 1.0.0 defect) is REJECTED by the enforcement: the
//    crossPlane requirement (ADR-0073) blocks a quorum that does not span both os-planes.
ok('verify-composite-release rejects a single-plane composite (the 1.0.0 defect)', () => {
  const singlePlane = clone(crossplane);
  singlePlane.machine.quorumVerdict.crossPlane = false; // as the shipped LINUX + VMware-Ubuntu quorum was
  const d = verifyCompositeRelease({ receipt: singlePlane, component: 'extension', version: '1.0.0' });
  assert.equal(d.publish, false);
  assert.ok(d.reasons.some((r) => /cross-plane/.test(r)), 'expected a cross-plane rejection reason');
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# crossplane-composite-reseal selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
