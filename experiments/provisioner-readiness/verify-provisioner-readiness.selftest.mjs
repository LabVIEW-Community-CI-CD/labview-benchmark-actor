#!/usr/bin/env node
// Self-test for provisionerReadiness.mjs (LBA-REQ-049, realizes ADR-0023 Phase 1). Binds the committed
// readiness receipt to the ACTUAL provisioner script on disk: the golden-VM provisioner must install every
// headless-LabVIEW prerequisite (Xvfb, VI Server :3363 config for BOTH exe basenames, quoted access lists,
// post-install reboot). Proves the verdict is deterministic AND fails closed if the provisioner regresses
// (a dropped step), if the ready verdict is forged, or if the digest is tampered. Pure -- no VM, no ripgrep.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReadinessReceipt, validateReadinessReceipt, digestReadinessReceipt,
  analyzeProvisioner, READINESS_SCHEMA,
} from './provisionerReadiness.mjs';
import {
  buildGoldenActivationReadinessReceipt,
  validateGoldenActivationReadinessReceipt,
  digestGoldenActivationReadiness,
  REQUIRED_RUNTIME_CHECKS,
  GOLDEN_ACTIVATION_READINESS_SCHEMA,
} from './goldenActivationReadiness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const scriptPath = 'cleanroom/ubuntu-labview/provision-guest.sh';
const realScript = readFileSync(join(repoRoot, scriptPath), 'utf8');
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'provisioner-headless-readiness-receipt.json'), 'utf8'));

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// 1. the committed fixture validates against the REAL provisioner AND is current (a fresh build reproduces it)
{
  const v = validateReadinessReceipt(committed, realScript);
  assert.ok(v.ok && v.ready, `committed receipt must validate + be ready: ${v.findings.join('; ')}`);
  assert.equal(committed.schema, READINESS_SCHEMA, 'schema is provisioner-headless-readiness@1');
  const rebuilt = buildReadinessReceipt({ scriptText: realScript, scriptPath });
  assert.deepEqual(rebuilt, committed, 'committed fixture equals a fresh build from the real script (regenerate the fixture if the provisioner changed)');
  ok('committed receipt validates against the real provisioner and is current (ready, all prerequisites present)');
}

// 2. deterministic: same script text -> byte-identical digest
{
  const a = buildReadinessReceipt({ scriptText: realScript, scriptPath });
  const b = buildReadinessReceipt({ scriptText: realScript, scriptPath });
  assert.equal(a.digest, b.digest, 'digest is deterministic');
  assert.equal(a.digest, committed.digest, 'digest matches the committed fixture');
  ok('receipt build is deterministic (stable digest)');
}

// 3. FAIL CLOSED: the provisioner regresses by dropping the Xvfb install
{
  assert.ok(/xvfb/i.test(realScript), 'precondition: the real script installs xvfb');
  const mutated = realScript.replace(/xvfb/gi, 'xdummy');
  const a = analyzeProvisioner(mutated);
  assert.ok(!a.allPresent && a.missing.includes('installs-xvfb'), 'dropping xvfb -> not ready');
  const v = validateReadinessReceipt(committed, mutated);
  assert.ok(!v.ok, 'the committed ready receipt must FAIL against a provisioner that no longer installs xvfb');
  ok('fail-closed: a provisioner that drops the Xvfb install is caught');
}

// 4. FAIL CLOSED: the provisioner drops the labviewcommunity.conf VI Server config (the exe-basename fix)
{
  assert.ok(/labviewcommunity\.conf/.test(realScript), 'precondition: the real script writes labviewcommunity.conf');
  const mutated = realScript.replace(/labviewcommunity/g, 'labview');
  const a = analyzeProvisioner(mutated);
  assert.ok(!a.allPresent && a.missing.includes('vi-server-config-labviewcommunity-conf'), 'dropping labviewcommunity.conf -> not ready');
  const v = validateReadinessReceipt(committed, mutated);
  assert.ok(!v.ok, 'the committed ready receipt must FAIL when the labviewcommunity.conf VI Server config is gone');
  ok('fail-closed: a provisioner that drops the labviewcommunity.conf VI Server config is caught');
}

// 5. FAIL CLOSED: the provisioner drops the post-install reboot handling
{
  assert.ok(/reboot/i.test(realScript), 'precondition: the real script addresses the reboot');
  const mutated = realScript.replace(/reboot/gi, 'restrt');
  const a = analyzeProvisioner(mutated);
  assert.ok(!a.allPresent && a.missing.includes('post-install-reboot'), 'dropping reboot -> not ready');
  const v = validateReadinessReceipt(committed, mutated);
  assert.ok(!v.ok, 'the committed ready receipt must FAIL when the post-install reboot step is gone');
  ok('fail-closed: a provisioner that drops the post-install reboot is caught');
}

// 6. FAIL CLOSED: a receipt that forges ready=true while a prerequisite is absent (resealed digest)
{
  const mutated = realScript.replace(/xvfb/gi, 'xdummy');
  const forged = buildReadinessReceipt({ scriptText: mutated, scriptPath }); // honest: ready=false
  forged.ready = true;
  forged.verdict.ready = true;
  forged.digest = digestReadinessReceipt(forged); // re-seal to hide the forgery
  const v = validateReadinessReceipt(forged, mutated);
  assert.ok(!v.ok, 'a forged ready=true verdict must be rejected when the script lacks a prerequisite');
  ok('fail-closed: a forged ready verdict (with a resealed digest) is rejected');
}

// 7. FAIL CLOSED: a tampered digest on the committed receipt
{
  const tampered = { ...committed, digest: '0'.repeat(64) };
  const v = validateReadinessReceipt(tampered, realScript);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

// 8. A live golden actor handoff receipt is deterministic and requires every no-secret prerequisite.
{
  const checks = Object.fromEntries(REQUIRED_RUNTIME_CHECKS.map((name) => [name, true]));
  const capture = {
    schema: 'labview-benchmark-actor/golden-activation-readiness-capture@1',
    mode: 'check',
    repairPerformed: false,
    rebootRequired: false,
    checks,
  };
  const receipt = buildGoldenActivationReadinessReceipt(capture);
  const v = validateGoldenActivationReadinessReceipt(receipt);
  assert.equal(receipt.schema, GOLDEN_ACTIVATION_READINESS_SCHEMA, 'golden readiness schema is stable');
  assert.ok(v.ok && v.ready, `all runtime prerequisites produce READY: ${v.findings.join('; ')}`);
  assert.equal(receipt.digest, digestGoldenActivationReadiness(receipt), 'golden readiness digest is deterministic');
  ok('golden activation readiness: all public prerequisites yield a deterministic READY handoff receipt');
}

// 9. Missing guest dependencies and tampered verdicts refuse the human activation handoff.
{
  const checks = Object.fromEntries(REQUIRED_RUNTIME_CHECKS.map((name) => [name, true]));
  checks.xvfb = false;
  const receipt = buildGoldenActivationReadinessReceipt({ checks });
  let v = validateGoldenActivationReadinessReceipt(receipt);
  assert.ok(v.ok && !v.ready && receipt.missing.includes('xvfb'), 'missing Xvfb yields an incomplete handoff receipt');
  receipt.ready = true;
  receipt.verdict.ready = true;
  receipt.digest = digestGoldenActivationReadiness(receipt);
  v = validateGoldenActivationReadinessReceipt(receipt);
  assert.ok(!v.ok && !v.ready, 'a resealed forged readiness verdict is rejected');
  ok('golden activation readiness: missing prerequisites and forged verdicts fail closed');
}

console.log(`\n# provisioner-headless-readiness self-test: ${n}/${n} passed`);
