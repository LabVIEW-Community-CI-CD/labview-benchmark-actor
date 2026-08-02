#!/usr/bin/env node
// Self-test for pplBuildBenchmark.mjs (LBA-REQ-051, realizes ADR-0033). Binds the committed PPL-build receipt
// (the BUILDER actor of the 2-actor icon-editor grid: LabVIEWCLI ExecuteBuildSpec of the "Editor Packed
// Library" spec inside the NI LabVIEW container -> lv_icon.lvlibp). Proves the receipt validates + is
// deterministic + the resultHash is machine-independent (timing/size-invariant), and FAILS CLOSED on a
// tampered resultHash, a forged verdict, a build that produced no artifact, or a tampered digest. Pure -- no
// LabVIEW / Docker / ripgrep.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPplReceipt, validatePplReceipt, computeResultHash, digestReceipt, RECEIPT_SCHEMA,
} from './pplBuildBenchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'ppl-build-benchmark-receipt.json'), 'utf8'));

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// 1. the committed receipt validates and the benchmark passed
{
  const v = validatePplReceipt(committed);
  assert.ok(v.ok && v.benchmarkOk, `committed receipt must validate + pass: ${v.findings.join('; ')}`);
  assert.equal(committed.schema, RECEIPT_SCHEMA, 'schema is ppl-build-benchmark@1');
  assert.equal(committed.generatedArtifact, 'lv_icon.lvlibp', 'produced the Editor Packed Library');
  assert.equal(committed.build.buildSpec, 'Editor Packed Library', 'built the icon-editor CI build spec');
  ok('committed PPL-build receipt validates and the build passed (lv_icon.lvlibp)');
}

// 2. deterministic: the same capture rebuilds byte-identically
{
  const capture = {
    plane: committed.plane, container: committed.container, labview: committed.labview,
    source: committed.source, target: committed.build.target, buildSpec: committed.build.buildSpec,
    generatedArtifact: committed.generatedArtifact, operationSucceeded: committed.operationSucceeded,
    buildSeconds: committed.timing.buildSeconds, artifactSizeBytes: committed.artifactSizeBytes, note: committed.note,
  };
  const a = buildPplReceipt(capture);
  const b = buildPplReceipt(capture);
  assert.equal(a.digest, b.digest, 'digest is deterministic');
  assert.equal(a.digest, committed.digest, 'rebuild matches the committed fixture');
  assert.equal(a.resultHash, committed.resultHash, 'resultHash matches the committed fixture');
  ok('receipt build is deterministic (stable digest + resultHash)');
}

// 3. resultHash is machine-independent + timing/size-invariant (same build identity on any plane)
{
  const otherPlane = buildPplReceipt({
    plane: 'some-other-runner', container: 'nationalinstruments/labview:2026q1-linux',
    source: committed.source, target: committed.build.target, buildSpec: committed.build.buildSpec,
    generatedArtifact: committed.generatedArtifact, operationSucceeded: true,
    buildSeconds: 999, artifactSizeBytes: 123456, // different perf/size
  });
  assert.equal(otherPlane.resultHash, committed.resultHash, 'same build identity -> same resultHash across planes');
  ok('resultHash is machine-independent (cross-plane comparable, timing/size-invariant)');
}

// 4. FAIL CLOSED: a tampered resultHash
{
  const t = { ...committed, resultHash: '0'.repeat(64) };
  const v = validatePplReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /resultHash/.test(f)), 'a tampered resultHash must be rejected');
  ok('fail-closed: a tampered resultHash is rejected');
}

// 5. FAIL CLOSED: a forged verdict (benchmarkOk flipped, digest resealed)
{
  const forged = structuredClone(committed);
  forged.operationSucceeded = false;      // the build actually failed...
  forged.verdict.benchmarkOk = true;      // ...but claim it passed
  forged.resultHash = computeResultHash({ project: forged.source.project, target: forged.build.target, buildSpec: forged.build.buildSpec, generatedArtifact: forged.generatedArtifact, operationSucceeded: false });
  forged.digest = digestReceipt(forged);  // re-seal
  const v = validatePplReceipt(forged);
  assert.ok(!v.ok, 'a forged benchmarkOk verdict must be rejected');
  ok('fail-closed: a forged verdict (resealed) is rejected');
}

// 6. FAIL CLOSED: the build produced no artifact
{
  const noArtifact = buildPplReceipt({
    source: committed.source, target: committed.build.target, buildSpec: committed.build.buildSpec,
    generatedArtifact: '', operationSucceeded: true,
  });
  assert.equal(noArtifact.verdict.benchmarkOk, false, 'no artifact -> benchmark fails');
  const v = validatePplReceipt(noArtifact);
  assert.ok(!v.ok, 'a build with no generated artifact must fail validation');
  ok('fail-closed: a build that produced no packed library is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const t = { ...committed, digest: '0'.repeat(64) };
  const v = validatePplReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# ppl-build-benchmark self-test: ${n}/${n} passed`);
