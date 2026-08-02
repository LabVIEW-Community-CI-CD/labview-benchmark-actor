#!/usr/bin/env node
// cross-plane-benchmark-grid@1 assembler + validator (LBA-REQ-050, realizes ADR-0023 / ADR-0031, roadmap
// Phase 4). The golden VM exists to run objective, reproducible LabVIEW benchmarks and compare them ACROSS
// PLANES (OS x hardware x LabVIEW version). This module unifies the per-benchmark cross-plane receipts into
// one grid: for every benchmark it records the machine-independent IDENTITY (resultHash) on each plane --
// proof LabVIEW reproduces across planes -- plus the PERFORMANCE metric (the actual benchmark). Identity must
// AGREE across planes; performance is expected to differ.
//
// Pure + rg-free + offline: the grid is DERIVED from committed benchmark receipts, so it re-derives byte-
// stably in CI (no LabVIEW, no VM). The gate fails closed on a determinism VIOLATION (a benchmark whose
// planes disagree on identity), a forged agreement/verdict, or a tampered digest.

import { createHash } from 'node:crypto';

export const GRID_SCHEMA = 'labview-benchmark-actor/cross-plane-benchmark-grid@1';

// Given a benchmark's planes ([{ planeId, identityHash, ... }]), decide cross-plane identity agreement.
//   >= 2 planes, all identity hashes equal -> agrees (true), consensus = that hash
//   >= 2 planes, not all equal            -> disagrees (false), consensus = null  (a determinism VIOLATION)
//   exactly 1 plane                        -> pending (null), consensus = that plane's hash
//   0 planes                               -> pending (null), consensus = null
export function summarizeAgreement(planes) {
  const hashes = (planes || []).map((p) => p.identityHash);
  if (hashes.length === 0) return { identityAgrees: null, consensusHash: null };
  if (hashes.length === 1) return { identityAgrees: null, consensusHash: hashes[0] };
  const allEqual = hashes.every((h) => h === hashes[0]);
  return { identityAgrees: allEqual, consensusHash: allEqual ? hashes[0] : null };
}

// Normalize a vi-analyzer cross-plane-comparison@1 receipt (already multi-plane) into a grid benchmark.
export function benchmarkFromViAnalyzerComparison(receipt) {
  const planes = (receipt.planes || []).map((p) => ({
    planeId: p.instance,
    os: p.os ?? null,
    identityHash: p.resultHash,
    performance: { metric: 'passedTests', value: p.passedTests ?? null, unit: 'tests' },
  }));
  return finalizeBenchmark({
    benchmarkId: 'vi-analyzer-example-project',
    title: 'VI Analyzer -- LabVIEWCLIExampleProject',
    identityKind: 'resultHash',
    planes,
  });
}

// Normalize a set of per-plane mass-compile-benchmark@1 receipts into one grid benchmark.
export function benchmarkFromMassCompileReceipts(receipts) {
  const planes = (receipts || []).map((r) => ({
    planeId: r.vm,
    os: r.labview ? 'linux' : null,
    identityHash: r.resultHash,
    performance: { metric: 'compileSeconds', value: r.timing?.compileSeconds ?? null, unit: 's' },
  }));
  return finalizeBenchmark({
    benchmarkId: 'mass-compile-icon-editor-resource',
    title: 'Mass Compile -- ni/labview-icon-editor resource/',
    identityKind: 'resultHash',
    planes,
  });
}

// Attach the agreement summary + plane count to a benchmark (planes already normalized).
export function finalizeBenchmark(b) {
  const planes = (b.planes || []).slice().sort((a, c) => a.planeId.localeCompare(c.planeId));
  const { identityAgrees, consensusHash } = summarizeAgreement(planes);
  return { ...b, planes, planeCount: planes.length, identityAgrees, consensusHash };
}

// Canonical verdict-bearing view (the digest input): schema + each benchmark's identity structure + gridOk.
// Performance is reported but NOT sealed -- it varies by machine, only the identity is a determinism claim.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    benchmarks: (receipt.benchmarks || []).map((b) => ({
      benchmarkId: b.benchmarkId,
      planes: b.planes.map((p) => ({ planeId: p.planeId, identityHash: p.identityHash })),
      identityAgrees: b.identityAgrees,
      consensusHash: b.consensusHash,
    })),
    gridOk: receipt.verdict?.gridOk,
  });
}

export function digestBenchmarkGrid(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Assemble the grid from normalized benchmarks. The grid is OK iff NO benchmark's planes disagree on identity
// (no determinism violation) AND at least one benchmark is genuinely cross-plane-proven (>= 2 agreeing
// planes) -- so an all-single-plane grid does not falsely claim cross-plane proof.
export function buildBenchmarkGrid(benchmarks) {
  const bs = (benchmarks || []).map(finalizeBenchmark);
  const planesUnion = [...new Set(bs.flatMap((b) => b.planes.map((p) => p.planeId)))].sort();
  const crossPlaneProven = bs.filter((b) => b.identityAgrees === true);
  const violations = bs.filter((b) => b.identityAgrees === false);
  const gridOk = violations.length === 0 && crossPlaneProven.length >= 1;
  const receipt = {
    schema: GRID_SCHEMA,
    benchmarks: bs,
    planesUnion,
    summary: {
      benchmarkCount: bs.length,
      crossPlaneProvenCount: crossPlaneProven.length,
      violationCount: violations.length,
      planeCount: planesUnion.length,
    },
    verdict: {
      gridOk,
      reason: gridOk
        ? `${crossPlaneProven.length} of ${bs.length} benchmark(s) cross-plane-proven across ${planesUnion.length} plane(s); no determinism violations`
        : violations.length > 0
          ? `${violations.length} benchmark(s) DISAGREE on identity across planes (determinism violation): ${violations.map((b) => b.benchmarkId).join(', ')}`
          : 'no benchmark is cross-plane-proven (>= 2 agreeing planes) yet',
    },
  };
  receipt.digest = digestBenchmarkGrid(receipt);
  return receipt;
}

// Validate a grid receipt: re-derive each benchmark's agreement + consensus from its planes, re-derive the
// grid verdict, assert the grid is OK, and check the digest. Fail-closed -- a disagreeing benchmark, a forged
// agreement/verdict, or a tampered digest yields ok=false.
export function validateBenchmarkGrid(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== GRID_SCHEMA) findings.push(`schema must be ${GRID_SCHEMA}`);
  if (!receipt || !Array.isArray(receipt.benchmarks) || !receipt.verdict) {
    return { ok: false, gridOk: false, findings: findings.concat('missing benchmarks/verdict') };
  }
  let derivedViolations = 0;
  let derivedProven = 0;
  for (const b of receipt.benchmarks) {
    const { identityAgrees, consensusHash } = summarizeAgreement(b.planes || []);
    if (b.identityAgrees !== identityAgrees) findings.push(`benchmark ${b.benchmarkId} identityAgrees=${b.identityAgrees} contradicts its planes (${identityAgrees})`);
    if (b.consensusHash !== consensusHash) findings.push(`benchmark ${b.benchmarkId} consensusHash contradicts its planes`);
    if ((b.planes || []).length !== b.planeCount) findings.push(`benchmark ${b.benchmarkId} planeCount contradicts its planes`);
    if (identityAgrees === false) derivedViolations += 1;
    if (identityAgrees === true) derivedProven += 1;
  }
  const derivedGridOk = derivedViolations === 0 && derivedProven >= 1;
  if (receipt.verdict.gridOk !== derivedGridOk) findings.push(`verdict.gridOk=${receipt.verdict.gridOk} contradicts the benchmarks (${derivedGridOk})`);
  if (!derivedGridOk) findings.push('the grid is not OK: a determinism violation or no cross-plane-proven benchmark');
  if (receipt.digest !== digestBenchmarkGrid(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, gridOk: !!receipt.verdict.gridOk && findings.length === 0, findings };
}

const short = (h) => (h ? `${String(h).slice(0, 8)}...` : '--');

// Render the grid as the flagship Markdown surface (docs/benchmarks/benchmark-grid.md). No markdown links
// (file paths are inline code) so it is Marketplace/link-check safe.
export function renderBenchmarkGridMarkdown(receipt, { sources = [] } = {}) {
  const v = receipt.verdict;
  const s = receipt.summary;
  const lines = [];
  lines.push('# Cross-Plane Benchmark Grid');
  lines.push('');
  lines.push('> GENERATED -- do not hand-edit. Regenerate with `node experiments/benchmark-grid/generate-benchmark-grid.mjs`; drift + determinism are gated by `cross-plane-benchmark-grid`.');
  lines.push('');
  lines.push('The golden VM exists to run objective, reproducible LabVIEW benchmarks and compare them **across planes** (OS x hardware x LabVIEW version). Each benchmark records a **machine-independent identity** (`resultHash`) -- proof LabVIEW reproduces across planes -- and a **performance** metric (the actual benchmark). Identity must **agree** across planes; performance is expected to differ.');
  lines.push('');
  lines.push(`**Grid verdict: ${v.gridOk ? 'OK' : 'FAIL'}** -- ${s.benchmarkCount} benchmark(s), ${s.crossPlaneProvenCount} cross-plane-proven, ${s.violationCount} determinism violation(s), ${s.planeCount} plane(s). ${v.reason}.`);
  lines.push('');
  lines.push('## Cross-plane identity (determinism)');
  lines.push('');
  lines.push('| Benchmark | Planes | Consensus identity | Agree? |');
  lines.push('| --- | --- | --- | --- |');
  for (const b of receipt.benchmarks) {
    const agree = b.identityAgrees === true ? `yes (${b.planeCount}/${b.planeCount})`
      : b.identityAgrees === false ? 'NO -- VIOLATION'
        : `pending (${b.planeCount} plane)`;
    lines.push(`| ${b.title} | ${b.planes.map((p) => `\`${p.planeId}\``).join(', ')} | \`${short(b.consensusHash)}\` | ${agree} |`);
  }
  lines.push('');
  lines.push('## Performance (per plane)');
  lines.push('');
  lines.push('| Benchmark | Plane | Metric | Value |');
  lines.push('| --- | --- | --- | --- |');
  for (const b of receipt.benchmarks) {
    for (const p of b.planes) {
      lines.push(`| ${b.title} | \`${p.planeId}\` | ${p.performance.metric} | ${p.performance.value ?? '--'} ${p.performance.unit} |`);
    }
  }
  lines.push('');
  lines.push('## Sources (committed benchmark receipts)');
  lines.push('');
  for (const src of sources) lines.push(`- \`${src}\``);
  lines.push('');
  return lines.join('\n');
}
