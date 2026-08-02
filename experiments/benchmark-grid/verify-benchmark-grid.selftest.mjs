#!/usr/bin/env node
// Self-test for benchmarkGrid.mjs (LBA-REQ-050, realizes ADR-0023 / ADR-0031, roadmap Phase 4). Proves the
// cross-plane benchmark grid derives from the committed benchmark receipts, the committed surface is current,
// and the grid FAILS CLOSED on a determinism violation (planes disagreeing on identity), a forged agreement
// or verdict, or a tampered digest. Pure -- no LabVIEW, no VM, no ripgrep.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  benchmarkFromViAnalyzerComparison, benchmarkFromMassCompileReceipts,
  buildBenchmarkGrid, validateBenchmarkGrid, digestBenchmarkGrid, GRID_SCHEMA,
} from './benchmarkGrid.mjs';
import { buildGridFromCommittedReceipts, renderCommittedGrid } from './generate-benchmark-grid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
const VI_SRC = 'experiments/vi-analyzer/fixtures/cross-plane-comparison-receipt.json';
const MC_GOLDEN = 'experiments/mass-compile/fixtures/mass-compile-benchmark-receipt.json';
const MC_HOST = 'experiments/benchmark-grid/fixtures/mass-compile-host.receipt.json';

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// 1. the grid derives from the committed receipts, validates, and is cross-plane OK
{
  const grid = buildGridFromCommittedReceipts();
  const v = validateBenchmarkGrid(grid);
  assert.ok(v.ok && v.gridOk, `committed grid must validate + be OK: ${v.findings.join('; ')}`);
  assert.equal(grid.schema, GRID_SCHEMA, 'schema is cross-plane-benchmark-grid@1');
  assert.equal(grid.benchmarks.length, 2, 'two benchmarks');
  const [vi, mc] = grid.benchmarks;
  assert.equal(vi.identityAgrees, true, 'VI Analyzer identity agrees across planes');
  assert.equal(vi.consensusHash.slice(0, 8), '0419a449', 'VI Analyzer consensus hash');
  assert.equal(mc.identityAgrees, true, 'Mass Compile identity agrees across planes');
  assert.equal(mc.consensusHash.slice(0, 8), 'bf722123', 'Mass Compile consensus hash');
  assert.equal(grid.summary.crossPlaneProvenCount, 2, 'both benchmarks cross-plane-proven');
  assert.equal(grid.summary.violationCount, 0, 'no determinism violations');
  ok('grid derives from committed receipts, validates, and is cross-plane OK (2/2 proven)');
}

// 2. the committed surface (docs/benchmarks/benchmark-grid.md) is CURRENT with the receipts
{
  const committed = readFileSync(join(repoRoot, 'docs/benchmarks/benchmark-grid.md'), 'utf8');
  assert.equal(renderCommittedGrid(), committed, 'benchmark-grid.md is stale -- regenerate with generate-benchmark-grid.mjs');
  ok('committed benchmark-grid.md surface is current with the source receipts');
}

// 3. deterministic: same receipts -> byte-identical digest
{
  const a = buildGridFromCommittedReceipts();
  const b = buildGridFromCommittedReceipts();
  assert.equal(a.digest, b.digest, 'grid digest is deterministic');
  ok('grid build is deterministic (stable digest)');
}

// 4. FAIL CLOSED: a benchmark whose planes DISAGREE on identity (a determinism violation)
{
  const viBad = structuredClone(readJson(VI_SRC));
  viBad.planes[1].resultHash = 'deadbeef'.repeat(8); // one plane now disagrees
  const vi = benchmarkFromViAnalyzerComparison(viBad);
  assert.equal(vi.identityAgrees, false, 'disagreeing planes -> identityAgrees false');
  const mc = benchmarkFromMassCompileReceipts([readJson(MC_GOLDEN), readJson(MC_HOST)]);
  const grid = buildBenchmarkGrid([vi, mc]);
  assert.equal(grid.verdict.gridOk, false, 'a determinism violation -> grid not OK');
  const v = validateBenchmarkGrid(grid);
  assert.ok(!v.ok, 'a grid with a determinism violation must FAIL validation');
  ok('fail-closed: a benchmark whose planes disagree on identity is caught (determinism violation)');
}

// 5. FAIL CLOSED: a forged identityAgrees=true while the planes actually disagree (resealed digest)
{
  const grid = buildGridFromCommittedReceipts();
  const forged = structuredClone(grid);
  forged.benchmarks[0].planes[1].identityHash = 'deadbeef'.repeat(8); // planes now disagree
  forged.benchmarks[0].identityAgrees = true; // ...but claim agreement
  forged.benchmarks[0].consensusHash = forged.benchmarks[0].planes[0].identityHash;
  forged.digest = digestBenchmarkGrid(forged); // re-seal to hide it
  const v = validateBenchmarkGrid(forged);
  assert.ok(!v.ok, 'a forged identityAgrees must be rejected when the planes disagree');
  ok('fail-closed: a forged identity-agreement (with a resealed digest) is rejected');
}

// 6. FAIL CLOSED: a forged gridOk=true while a benchmark has a real violation (resealed digest)
{
  const viBad = structuredClone(readJson(VI_SRC));
  viBad.planes[1].resultHash = 'deadbeef'.repeat(8);
  const vi = benchmarkFromViAnalyzerComparison(viBad);
  const mc = benchmarkFromMassCompileReceipts([readJson(MC_GOLDEN), readJson(MC_HOST)]);
  const grid = buildBenchmarkGrid([vi, mc]);
  grid.verdict.gridOk = true; // forge the verdict
  grid.digest = digestBenchmarkGrid(grid); // re-seal
  const v = validateBenchmarkGrid(grid);
  assert.ok(!v.ok, 'a forged gridOk must be rejected when a benchmark violates determinism');
  ok('fail-closed: a forged grid verdict (with a resealed digest) is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const grid = buildGridFromCommittedReceipts();
  const tampered = { ...grid, digest: '0'.repeat(64) };
  const v = validateBenchmarkGrid(tampered);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# cross-plane-benchmark-grid self-test: ${n}/${n} passed`);
