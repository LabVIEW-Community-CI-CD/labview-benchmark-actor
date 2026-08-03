#!/usr/bin/env node
// Self-test: the mesh carries a second benchmark family (LBA-REQ-083 / ADR-0064). Pure + offline: proves the
// committed VI Analyzer mesh-run family record re-derives from the real committed VI Analyzer captures, the mesh
// fulfilled it via the LBA-REQ-073 engine as a benchmark DISTINCT from launch, and every fail-closed guard fires.
// Gated by `mesh-benchmark-family-vi-analyzer`.
// Run: `node experiments/mesh-fulfillment/viAnalyzerMeshRun.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFamilyRun, validateFamilyRun, committedContext, RUN_SCHEMA, REQUIREMENT } from './viAnalyzerMeshRun.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseCtx = committedContext(here);
const committed = JSON.parse(readFileSync(join(here, 'mesh-run-vi-analyzer-family.json'), 'utf8'));
const parity = JSON.parse(readFileSync(join(here, '..', 'vi-analyzer', 'cross-plane-vi-analyzer-parity-receipt.json'), 'utf8'));
const ctx = () => JSON.parse(JSON.stringify(baseCtx));
const clone = () => JSON.parse(JSON.stringify(committed));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed family run validates, the mesh carried it, and its identity is the VI Analyzer benchmark
//    identity (the SAME identity the LBA-REQ-081 parity receipt proves) -- a distinct family from launch.
ok('committed VI Analyzer mesh-run validates + is carried', () => {
  const r = validateFamilyRun(committed, baseCtx);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'the mesh should carry the VI Analyzer benchmark');
  assert.equal(committed.schema, RUN_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
  assert.equal(committed.identity, parity.benchmarkIdentity, 'same VI Analyzer identity as the LBA-REQ-081 parity');
  assert.equal(committed.distinctFromLaunch, true, 'a distinct family from the launch benchmark');
});

// 2. it re-derives byte-for-byte from the real committed VI Analyzer captures (currency + grounding).
ok('re-derives from the committed VI Analyzer evidence', () => {
  assert.equal(JSON.stringify(buildFamilyRun(baseCtx)), JSON.stringify(committed), 'run is stale vs the evidence');
  assert.equal(committed.fulfillment.verdict.fulfilled, true, 'the LBA-REQ-073 engine fulfilled the run');
  assert.equal(committed.fulfillment.fulfillment.distinctActors, 2, 'two distinct cross-plane actors');
});

// 3. FAIL-CLOSED: the embedded fulfillment is not proven (only one actor responded).
ok('rejects an unfulfilled run', () => {
  const c = clone(); c.fulfillment.actors = c.fulfillment.actors.slice(0, 1);
  assert.equal(validateFamilyRun(c, baseCtx).ok, false);
});

// 4. FAIL-CLOSED: the actor receipts do not descend from the real evidence (validate against a tampered capture).
ok('rejects actor receipts that do not descend from the evidence', () => {
  const c = ctx(); c.linuxEvidence.runs[0].wallMs += 5000;
  const r = validateFamilyRun(committed, c);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /descend/.test(f)));
});

// 5. FAIL-CLOSED: the distinct-from-launch flag is tampered.
ok('rejects a tampered distinctFromLaunch flag', () => {
  const c = clone(); c.distinctFromLaunch = false;
  assert.equal(validateFamilyRun(c, baseCtx).ok, false);
});

// 6. FAIL-CLOSED: the run claims a different (non-VI-Analyzer) benchmark.
ok('rejects a non-VI-Analyzer benchmark', () => {
  const c = clone(); c.benchmark.workload = 'labview-ide-launch';
  const r = validateFamilyRun(c, baseCtx);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /VI Analyzer benchmark|identity/.test(f)));
});

// 7. FAIL-CLOSED: a tampered digest.
ok('rejects a tampered digest', () => {
  const c = clone(); c.digest = '0'.repeat(64);
  const r = validateFamilyRun(c, baseCtx);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-benchmark-family-vi-analyzer selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
