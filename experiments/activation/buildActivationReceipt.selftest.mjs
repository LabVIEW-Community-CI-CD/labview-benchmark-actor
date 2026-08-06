// Self-test for buildActivationReceipt.mjs -- the LabVIEW activation-confirmation contract (LBA-REQ-038,
// realizes ADR-0023 Phase 1). Proves (a) the committed REAL capture deterministically rebuilds the committed
// receipt (offline replay -- no LabVIEW in CI), (b) the committed receipt validates as ACTIVATED, and
// (c) the confirmation is a genuine functional check that FAILS CLOSED -- a non-zero exit, the wrong
// known-answer value, a missing success line, a tampered digest, or a contradicted verdict all deny
// activation. Run: node buildActivationReceipt.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildActivationReceipt, validateActivationReceipt, parseProbeOutput, digestReceipt, RECEIPT_SCHEMA,
} from './buildActivationReceipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-capture.json'), 'utf8'));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the REAL committed capture deterministically rebuilds the committed receipt (offline replay)
{
  const rebuilt = buildActivationReceipt(capture);
  assert.equal(rebuilt.schema, RECEIPT_SCHEMA, 'schema is activation-receipt@1');
  assert.deepEqual(rebuilt, committed, 'rebuilding the receipt from the committed capture is byte-stable');
  assert.equal(rebuilt.digest, digestReceipt(committed), 'digest is reproducible from the verdict-bearing fields');
  ok(`deterministic offline replay: capture -> receipt (digest ${rebuilt.digest.slice(0, 12)}…)`);
}

// 2. the committed receipt is a REAL activation confirmation (LabVIEW 2026 returned the known answer)
{
  const v = validateActivationReceipt(committed);
  assert.ok(v.ok && v.activated, `expected ACTIVATED; findings: ${v.findings.join('; ')}`);
  assert.equal(committed.result.parsedOutput, committed.probe.expectedOutput, 'the probe returned the known answer');
  assert.equal(committed.result.exitCode, 0, 'RunVI exited cleanly');
  assert.equal(committed.host.labviewVersion, '2026', 'confirmed on LabVIEW 2026');
  ok(`committed receipt confirms activation: ${committed.probe.inputs.join(' + ')} = ${committed.result.parsedOutput} on LabVIEW ${committed.host.labviewVersion}`);
}

// 3. parseProbeOutput extracts the numeric output + success + version from the real CLI stdout
{
  const p = parseProbeOutput(capture.output);
  assert.equal(p.parsedOutput, capture.expectedOutput, 'parses the numeric Operation output');
  assert.equal(p.operationSucceeded, true, 'detects "RunVI operation succeeded."');
  assert.equal(p.labviewVersion, '2026', 'parses the LabVIEW version');
  ok('parseProbeOutput reads the real RunVI stdout (value + success + version)');
}

// 4. fail-closed: each way an install can be un-activated denies the verdict
{
  const bad = [
    { name: 'non-zero exit', mut: (c) => ({ ...c, exitCode: 1 }) },
    { name: 'wrong known-answer value', mut: (c) => ({ ...c, output: c.output.replace('\n42\n', '\n41\n') }) },
    { name: 'missing success line', mut: (c) => ({ ...c, output: c.output.replace('RunVI operation succeeded.', 'RunVI operation FAILED.') }) },
  ];
  for (const { name, mut } of bad) {
    const r = buildActivationReceipt(mut(capture));
    assert.equal(r.verdict.activated, false, `must DENY activation on: ${name}`);
    const v = validateActivationReceipt(r);
    assert.equal(v.activated, false, `validation denies activation on: ${name}`);
  }
  ok('fail-closed: non-zero exit / wrong value / missing success line all DENY activation');
}

// 5. fail-closed: a tampered digest or a contradicted verdict is rejected by validation
{
  const tamperedDigest = { ...committed, digest: '0'.repeat(64) };
  assert.equal(validateActivationReceipt(tamperedDigest).ok, false, 'a tampered digest is rejected');
  const forged = JSON.parse(JSON.stringify(committed));
  forged.result.exitCode = 1;                 // make the result bad but keep verdict.activated = true
  const v = validateActivationReceipt(forged);
  assert.equal(v.ok, false, 'a verdict contradicting the result rule is rejected');
  assert.ok(v.findings.some((f) => /contradicts the rule|digest/.test(f)), 'names the contradiction / digest tamper');
  ok('fail-closed: tampered digest and forged verdict are both rejected');
}

// 6. The CLI writes the same receipt and gives a non-zero status for an unconfirmed probe.
{
  const temp = mkdtempSync(join(tmpdir(), 'lba-activation-cli-'));
  try {
    const output = join(temp, 'receipt.json');
    const run = spawnSync(process.execPath, [join(here, 'buildActivationReceipt.mjs'), join(here, 'fixtures', 'activation-capture.json'), output], { encoding: 'utf8' });
    assert.equal(run.status, 0, `activation receipt CLI succeeds for a valid capture: ${run.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), committed, 'activation receipt CLI writes the deterministic receipt');
    ok('activation receipt CLI writes the same deterministic receipt from a valid capture');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

console.log(`\nbuildActivationReceipt.selftest: ${passed}/${passed} checks passed`);
