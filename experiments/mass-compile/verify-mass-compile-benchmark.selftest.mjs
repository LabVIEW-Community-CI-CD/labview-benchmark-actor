// Self-test for massCompileBenchmark.mjs -- golden-VM Mass Compile benchmark (LBA-REQ-048, ADR-0023 Phase 1;
// replaces the deferred VI Analyzer benchmark). Asserts the committed REAL benchmark receipt validates + the
// benchmark passed, that it replays deterministically, that the resultHash is machine-independent
// (timing-invariant, so it is cross-plane comparable), and that validation FAILS CLOSED on a tampered
// resultHash, a forged verdict, a bad-VI list inconsistent with the count, or a tampered digest. Pure +
// rg-free + offline (no LabVIEW). Run: node verify-mass-compile-benchmark.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RECEIPT_SCHEMA, computeResultHash, buildMassCompileReceipt, validateMassCompileReceipt, digestReceipt } from './massCompileBenchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'mass-compile-benchmark-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// 1. the committed real benchmark receipt validates and the benchmark passed
{
  const r = validateMassCompileReceipt(receipt);
  assert.ok(r.ok && r.benchmarkOk, `expected a valid passing benchmark; findings: ${r.findings.join('; ')}`);
  assert.equal(receipt.schema, RECEIPT_SCHEMA, 'schema');
  assert.equal(receipt.operationSucceeded, true, 'MassCompile succeeded');
  assert.equal(receipt.badViCount, 0, '0 bad VIs');
  assert.ok(receipt.visInDirectory > 0, 'non-empty directory');
  ok(`committed benchmark valid: MassCompile ${receipt.source.directory} = ${receipt.visInDirectory} VIs/CTLs, ${receipt.badViCount} bad, succeeded (${receipt.timing.compileSeconds}s)`);
}

// 2. deterministic replay: rebuilding yields the identical digest + resultHash
{
  const rebuilt = buildMassCompileReceipt(receipt);
  assert.equal(rebuilt.digest, receipt.digest, 'rebuilt digest matches');
  assert.equal(rebuilt.resultHash, receipt.resultHash, 'rebuilt resultHash matches');
  ok('benchmark replays deterministically (rebuild -> identical digest + resultHash)');
}

// 3. the resultHash is machine-independent (cross-plane comparable): it re-derives from the result fields
//    only, and is invariant to the recorded timing
{
  const h = computeResultHash({ directory: receipt.source.directory, visInDirectory: receipt.visInDirectory, badViCount: receipt.badViCount, badVis: receipt.badVis, operationSucceeded: receipt.operationSucceeded });
  assert.equal(h, receipt.resultHash, 'resultHash re-derives from the result fields');
  const otherTiming = buildMassCompileReceipt({ ...receipt, compileSeconds: 999, cliElapsedMs: 123456 });
  assert.equal(otherTiming.resultHash, receipt.resultHash, 'resultHash is independent of timing (cross-plane comparable)');
  ok(`resultHash is machine-independent (timing-invariant): ${receipt.resultHash.slice(0, 16)}...`);
}

// 4. fail-closed: a tampered resultHash
{
  const t = clone(receipt);
  t.resultHash = '0'.repeat(64);
  t.digest = digestReceipt(t);
  const r = validateMassCompileReceipt(t);
  assert.equal(r.ok, false, 'a tampered resultHash FAILS');
  assert.ok(r.findings.some((f) => /resultHash/.test(f)), 'names the resultHash');
  ok('fail-closed: tampered resultHash rejected');
}

// 5. fail-closed: a forged verdict (operation failed but benchmarkOk claimed true)
{
  const f = clone(receipt);
  f.operationSucceeded = false;
  f.verdict.benchmarkOk = true; // the lie
  f.resultHash = computeResultHash({ directory: f.source.directory, visInDirectory: f.visInDirectory, badViCount: f.badViCount, badVis: f.badVis, operationSucceeded: false });
  f.digest = digestReceipt(f); // re-seal so only the verdict RULE catches it
  const r = validateMassCompileReceipt(f);
  assert.equal(r.ok, false, 'benchmarkOk=true while the operation failed is rejected');
  assert.ok(r.findings.some((x) => /contradicts the rule/.test(x)), 'names the contradiction');
  ok('fail-closed: forged verdict rejected');
}

// 6. fail-closed: a bad-VI list that disagrees with badViCount
{
  const b = buildMassCompileReceipt({ ...receipt, badViCount: 2, badVis: [] }); // claim 2 bad, list empty
  const r = validateMassCompileReceipt(b);
  assert.equal(r.ok, false, 'badVis length != badViCount FAILS');
  assert.ok(r.findings.some((x) => /badVis list length/.test(x)), 'names the mismatch');
  ok('fail-closed: bad-VI list inconsistent with badViCount rejected');
}

// 7. fail-closed: a tampered digest
{
  const t = clone(receipt);
  t.digest = '0'.repeat(64);
  const r = validateMassCompileReceipt(t);
  assert.equal(r.ok, false, 'a tampered digest FAILS');
  assert.ok(r.findings.some((f) => /digest/.test(f)), 'names the digest');
  ok('fail-closed: tampered digest rejected');
}

console.log(`\nverify-mass-compile-benchmark.selftest: ${passed}/${passed} checks passed`);
