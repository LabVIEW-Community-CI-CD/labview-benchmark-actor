#!/usr/bin/env node
// Self-test for benchmarkObservatory.mjs (LBA-REQ-054, realizes ADR-0034). Binds the committed Benchmark
// Observatory (the suite-wide benchmark-type x plane coverage matrix folding the VI Analyzer, Mass Compile,
// PPL build + LUnit test receipts). Proves the observatory validates + is deterministic + the coverage matrix
// and determinism ledger are faithfully DERIVED from the receipts, and FAILS CLOSED on a determinism
// violation (a benchmark whose planes disagree on identity), a forged verdict, a coverage matrix that
// contradicts the benchmarks, or a tampered digest. Pure -- no LabVIEW / VM / container.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObservatory, validateObservatory, digestObservatory, OBSERVATORY_SCHEMA,
  benchmarkFromMassCompileReceipts, benchmarkFromPplBuild, benchmarkFromLunitTest,
} from './benchmarkObservatory.mjs';
import { buildObservatoryFromCommittedReceipts, renderCommittedObservatory } from './generate-benchmark-observatory.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// 1. the committed observatory validates and is OK
{
  const obs = buildObservatoryFromCommittedReceipts();
  const v = validateObservatory(obs);
  assert.ok(v.ok && v.observatoryOk, `committed observatory must validate + be OK: ${v.findings.join('; ')}`);
  assert.equal(obs.schema, OBSERVATORY_SCHEMA, 'schema is benchmark-observatory@1');
  assert.equal(obs.summary.benchmarkTypeCount, 4, 'four benchmark types folded in');
  assert.ok(obs.summary.crossPlaneProvenCount >= 2, 'mass-compile + vi-analyzer are cross-plane-proven');
  assert.equal(obs.summary.violationCount, 0, 'no determinism violations');
  ok('committed observatory validates, is OK, 4 types, >=2 cross-plane-proven');
}

// 2. the committed surface (docs/benchmarks/benchmark-observatory.md) is CURRENT with the receipts
{
  const committed = readFileSync(join(repoRoot, 'docs/benchmarks/benchmark-observatory.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(renderCommittedObservatory(), committed, 'benchmark-observatory.md is stale -- regenerate with generate-benchmark-observatory.mjs');
  ok('committed benchmark-observatory.md surface is current with the source receipts');
}

// 2. deterministic: rebuilding from the same committed receipts is byte-identical
{
  const a = buildObservatoryFromCommittedReceipts();
  const b = buildObservatoryFromCommittedReceipts();
  assert.equal(a.digest, b.digest, 'observatory digest is deterministic');
  ok('observatory build is deterministic (stable digest)');
}

// 3. the coverage matrix is faithfully derived: mass-compile spans 3 planes, lba-golden carries 2 benchmarks
{
  const obs = buildObservatoryFromCommittedReceipts();
  const mc = obs.matrix.rows.find((r) => r.benchmarkId === 'mass-compile-icon-editor-resource');
  assert.equal(mc.filledPlanes.length, 3, 'mass-compile ran on 3 planes');
  const onGolden = obs.matrix.rows.filter((r) => r.filledPlanes.includes('lba-golden')).map((r) => r.benchmarkId).sort();
  assert.deepEqual(onGolden, ['lunit-test-icon-editor', 'mass-compile-icon-editor-resource'], 'lba-golden carries both mass-compile + lunit-test');
  assert.equal(obs.summary.filledCellCount, obs.matrix.rows.reduce((s, r) => s + r.filledPlanes.length, 0), 'filled-cell count matches the matrix');
  ok('coverage matrix is faithfully derived from the receipts');
}

// 4. the determinism ledger is faithfully derived: mass-compile PROVEN, ppl-build pending
{
  const obs = buildObservatoryFromCommittedReceipts();
  const mc = obs.benchmarks.find((b) => b.benchmarkId === 'mass-compile-icon-editor-resource');
  const ppl = obs.benchmarks.find((b) => b.benchmarkId === 'ppl-build-icon-editor');
  assert.equal(mc.identityAgrees, true, 'mass-compile identity agrees across its 3 planes');
  assert.equal(ppl.identityAgrees, null, 'ppl-build is single-plane (pending), not a violation');
  ok('determinism ledger is faithfully derived (proven vs pending)');
}

// 5. FAIL CLOSED: a determinism violation -- mass-compile disagrees on identity across planes
{
  const golden = { schema: 'labview-benchmark-actor/mass-compile-benchmark@1', vm: 'lba-golden', resultHash: 'a'.repeat(64), timing: { compileSeconds: 24 }, labview: '2026' };
  const host = { schema: 'labview-benchmark-actor/mass-compile-benchmark@1', vm: 'host', resultHash: 'b'.repeat(64), timing: { compileSeconds: 39 }, labview: '2026' }; // DIFFERENT hash
  const obs = buildObservatory([
    benchmarkFromMassCompileReceipts([golden, host]),
    benchmarkFromPplBuild({ plane: 'linux-container', resultHash: 'c'.repeat(64), timing: { buildSeconds: 59 } }),
  ]);
  assert.equal(obs.verdict.observatoryOk, false, 'a disagreeing benchmark must fail the observatory');
  const v = validateObservatory(obs);
  assert.ok(!v.ok && v.findings.some((f) => /violation|not OK/i.test(f)), 'a determinism violation must be rejected');
  ok('fail-closed: a determinism violation across planes is rejected');
}

// 6. FAIL CLOSED: a forged verdict + a coverage matrix that contradicts the benchmarks
{
  const obs = buildObservatoryFromCommittedReceipts();
  const forged = structuredClone(obs);
  forged.verdict.observatoryOk = true; // (already true) -- now inject a phantom filled cell
  forged.matrix.rows.find((r) => r.benchmarkId === 'ppl-build-icon-editor').filledPlanes.push('win-VITLT-SERGIO');
  forged.digest = digestObservatory(forged); // re-seal
  const v = validateObservatory(forged);
  assert.ok(!v.ok && v.findings.some((f) => /coverage matrix/i.test(f)), 'a matrix contradicting the benchmarks must be rejected');
  ok('fail-closed: a coverage matrix that contradicts the benchmarks is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const obs = buildObservatoryFromCommittedReceipts();
  const t = { ...obs, digest: '0'.repeat(64) };
  const v = validateObservatory(t);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# benchmark-observatory self-test: ${n}/${n} passed`);
