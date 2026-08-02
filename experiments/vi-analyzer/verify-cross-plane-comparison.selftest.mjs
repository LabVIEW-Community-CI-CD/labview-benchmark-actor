// Self-test for crossPlaneComparison.mjs -- cross-plane VI Analyzer comparison (LBA-REQ-043, ADR-0031).
// Replays the committed REAL receipt (host + a LabVIEW VM ran the same VI Analyzer config; the resultHashes
// MATCH = cross-plane determinism) offline -- no LabVIEW, no VM in CI -- and proves validation FAILS CLOSED
// when the hashes diverge. rg-free. Run: node verify-cross-plane-comparison.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildComparisonReceipt, validateComparison, COMPARISON_SCHEMA } from './crossPlaneComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'cross-plane-comparison-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = () => JSON.parse(JSON.stringify(receipt));

// 1. the committed receipt proves cross-plane determinism: same config, matching resultHash across planes
{
  const v = validateComparison(receipt);
  assert.ok(v.ok, `expected a valid cross-plane comparison; findings: ${v.findings.join('; ')}`);
  assert.equal(receipt.schema, COMPARISON_SCHEMA, 'schema is cross-plane-comparison@1');
  assert.ok(receipt.planeCount >= 2, 'at least two planes');
  assert.equal(receipt.resultHashesMatch, true, 'resultHashes match across planes');
  assert.ok(receipt.consensusHash && receipt.consensusHash.length >= 16, 'a consensus resultHash is recorded');
  const hashes = new Set(receipt.planes.map((p) => p.resultHash));
  assert.equal(hashes.size, 1, 'every plane produced the identical resultHash');
  ok(`committed receipt: ${receipt.planeCount} planes agree on resultHash ${receipt.consensusHash.slice(0, 12)}… (${receipt.planes[0].totalTests} tests)`);
}

// 2. the planes are distinct instances (a real host + a real VM)
{
  assert.equal(new Set(receipt.planes.map((p) => p.hostname)).size, receipt.planes.length, 'planes are distinct hosts');
  assert.ok(receipt.planes.some((p) => p.instance === 'host'), 'the host is one plane');
  assert.ok(receipt.planes.some((p) => p.instance.startsWith('vm:')), 'a LabVIEW VM is another plane');
  ok('planes are distinct: the host + a LabVIEW VM');
}

// 3. buildComparisonReceipt: identical summaries agree; a divergent one does not
{
  const s = (h) => ({ resultHash: h, totalTests: 69, passedTests: 69, totalFindings: 0, pass: true });
  const agree = buildComparisonReceipt({ benchmark: 'b', planes: [
    { instance: 'host', hostname: 'h', summary: s('AAAA0000AAAA0000') },
    { instance: 'vm:v', hostname: 'v', summary: s('AAAA0000AAAA0000') },
  ] });
  assert.equal(validateComparison(agree).ok, true, 'matching resultHashes validate');
  const diverge = buildComparisonReceipt({ benchmark: 'b', planes: [
    { instance: 'host', hostname: 'h', summary: s('AAAA0000AAAA0000') },
    { instance: 'vm:v', hostname: 'v', summary: s('BBBB1111BBBB1111') },
  ] });
  assert.equal(diverge.resultHashesMatch, false, 'divergent resultHashes are flagged');
  assert.equal(validateComparison(diverge).ok, false, 'divergent resultHashes FAIL validation');
  ok('buildComparisonReceipt agrees on identical hashes, fails on divergent ones');
}

// 4. fail-closed: a tampered plane hash, a single plane, or resultHashesMatch=false are each rejected
{
  const tampered = clone(); tampered.planes[1].resultHash = '0'.repeat(64);
  assert.equal(validateComparison(tampered).ok, false, 'a divergent plane hash is rejected');
  const one = clone(); one.planes = [one.planes[0]]; one.planeCount = 1;
  assert.equal(validateComparison(one).ok, false, 'a single plane is not a cross-plane comparison');
  const lie = clone(); lie.planes[1].resultHash = '0'.repeat(64); lie.resultHashesMatch = true; lie.consensusHash = lie.planes[0].resultHash;
  assert.equal(validateComparison(lie).ok, false, 'a forged resultHashesMatch is caught');
  ok('fail-closed: divergent hash / single plane / forged match all rejected');
}

console.log(`\nverify-cross-plane-comparison.selftest: ${passed}/${passed} checks passed`);
