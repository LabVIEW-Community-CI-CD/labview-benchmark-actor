// Self-test for crossPlaneLiveness.mjs -- cross-plane LabVIEW liveness (LBA-REQ-042, ADR-0030). Replays the
// committed REAL receipt (this host + a LabVIEW VM each ran the known-answer probe concurrently, both
// activated) offline -- no LabVIEW, no VM in CI -- and proves validation FAILS CLOSED. rg-free.
// Run: node verify-cross-plane-liveness.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLivenessReceipt, validateLiveness, LIVENESS_SCHEMA } from './crossPlaneLiveness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'cross-plane-liveness-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = () => JSON.parse(JSON.stringify(receipt));

// 1. the committed receipt proves >= 2 activated LabVIEW planes
{
  const v = validateLiveness(receipt);
  assert.ok(v.ok, `expected a valid cross-plane liveness receipt; findings: ${v.findings.join('; ')}`);
  assert.equal(receipt.schema, LIVENESS_SCHEMA, 'schema is cross-plane-liveness@1');
  assert.ok(receipt.planeCount >= 2, 'at least two LabVIEW planes');
  assert.equal(receipt.allActivated, true, 'every plane is activated');
  for (const p of receipt.planes) {
    assert.equal(p.parsedOutput, p.expectedOutput, `plane ${p.instance} returned the known answer`);
    assert.equal(p.activated, true, `plane ${p.instance} is activated`);
  }
  ok(`committed receipt: ${receipt.planeCount} activated LabVIEW planes (${receipt.planes.map((p) => p.instance).join(', ')})`);
}

// 2. the planes are distinct instances (a real host + a real VM), each on LabVIEW
{
  assert.equal(new Set(receipt.planes.map((p) => p.hostname)).size, receipt.planes.length, 'planes are distinct hosts');
  assert.ok(receipt.planes.some((p) => p.instance === 'host'), 'the host is one plane');
  assert.ok(receipt.planes.some((p) => p.instance.startsWith('vm:')), 'a LabVIEW VM is another plane');
  ok('planes are distinct: the host + a LabVIEW VM');
}

// 3. buildLivenessReceipt derives activation from a raw probe stdout (known answer + RunVI success)
{
  const good = 'Using LabVIEW: "/usr/local/natinst/LabVIEW-2026-64/labview"\nOperation output: \n12\nRunVI operation succeeded.\n';
  const r = buildLivenessReceipt({ workload: 'x', planes: [
    { instance: 'host', hostname: 'h', inputs: [7, 5], expectedOutput: 12, exitCode: 0, output: good },
    { instance: 'vm:v', hostname: 'v', inputs: [7, 5], expectedOutput: 12, exitCode: 0, output: good },
  ] });
  assert.equal(validateLiveness(r).ok, true, 'two good probe outputs build a valid receipt');
  assert.equal(r.planes[0].labviewVersion, '2026', 'parses the LabVIEW version from stdout');
  ok('buildLivenessReceipt derives activation from real probe stdout');
}

// 4. fail-closed: wrong answer, only one plane, a shared host, or allActivated=false are each rejected
{
  const wrong = clone(); wrong.planes[0].parsedOutput = 11; wrong.planes[0].activated = false; wrong.allActivated = false;
  assert.equal(validateLiveness(wrong).ok, false, 'a plane with the wrong answer is rejected');

  const one = clone(); one.planes = [one.planes[0]]; one.planeCount = 1;
  assert.equal(validateLiveness(one).ok, false, 'a single plane is not cross-plane');

  const shared = clone(); shared.planes[1].hostname = shared.planes[0].hostname;
  assert.equal(validateLiveness(shared).ok, false, 'two planes on the same host are rejected');

  const notLive = clone(); notLive.allActivated = false;
  assert.equal(validateLiveness(notLive).ok, false, 'allActivated=false is rejected');
  ok('fail-closed: wrong answer / single plane / shared host / not-all-activated all rejected');
}

console.log(`\nverify-cross-plane-liveness.selftest: ${passed}/${passed} checks passed`);
