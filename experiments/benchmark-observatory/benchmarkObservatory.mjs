#!/usr/bin/env node
// benchmark-observatory@1 assembler + validator (LBA-REQ-054, realizes ADR-0034). The Benchmark Observatory
// is the suite-wide map ABOVE the cross-plane grid (ADR-0031): it folds EVERY committed benchmark receipt --
// the VI Analyzer comparison, the Mass Compile benchmark (host + golden VM + Windows), and the 2-actor
// icon-editor grid (the PPL BUILD + the LUnit TEST) -- into one benchmark-type x plane COVERAGE MATRIX. It
// keeps the grid's determinism ledger (does a benchmark's identity AGREE across the planes it ran on?) and
// adds two things the grid lacks: (1) a coverage matrix over the whole suite (which benchmark type has run
// on which plane) and (2) a data-driven FRONTIER (the empty cells -- the next measurements to take).
//
// Pure + rg-free + offline: the observatory is DERIVED from committed receipts, so it re-derives byte-stably
// in CI (no LabVIEW / VM / container). It fails closed on a determinism VIOLATION (a benchmark whose planes
// disagree on identity), a coverage-matrix that contradicts the benchmarks, a forged verdict, or a tampered
// digest.

import { createHash } from 'node:crypto';
import {
  summarizeAgreement, finalizeBenchmark,
  benchmarkFromViAnalyzerComparison, benchmarkFromMassCompileReceipts,
} from '../benchmark-grid/benchmarkGrid.mjs';

export const OBSERVATORY_SCHEMA = 'labview-benchmark-actor/benchmark-observatory@1';

// Re-export the grid normalizers the observatory shares, so callers assemble every benchmark from one place.
export { benchmarkFromViAnalyzerComparison, benchmarkFromMassCompileReceipts };

// Normalize the ppl-build-benchmark@1 receipt (icon-editor "Editor Packed Library" build) into a benchmark.
export function benchmarkFromPplBuild(receipt) {
  return finalizeBenchmark({
    benchmarkId: 'ppl-build-icon-editor',
    title: 'PPL Build -- ni/labview-icon-editor Editor Packed Library',
    identityKind: 'resultHash',
    planes: [{
      planeId: receipt.plane ?? 'linux-container',
      os: 'linux',
      identityHash: receipt.resultHash,
      performance: { metric: 'buildSeconds', value: receipt.timing?.buildSeconds ?? null, unit: 's' },
    }],
  });
}

// Normalize the lunit-test-benchmark@1 receipt (icon-editor LUnit suite) into a benchmark. The verbose
// `plane` string ("linux-vm (lba-golden ...)") is normalized to the shared plane id `lba-golden`.
export function benchmarkFromLunitTest(receipt) {
  const planeId = /lba-golden/.test(receipt.plane || '') ? 'lba-golden' : (receipt.plane ?? 'linux-vm');
  return finalizeBenchmark({
    benchmarkId: 'lunit-test-icon-editor',
    title: 'LUnit Test -- ni/labview-icon-editor suite',
    identityKind: 'resultHash',
    planes: [{
      planeId,
      os: 'linux',
      identityHash: receipt.resultHash,
      performance: { metric: 'testsRun', value: receipt.total ?? null, unit: 'cases' },
    }],
  });
}

// Build the coverage matrix: for every benchmark (row) x plane (column), a cell that is filled iff that
// benchmark ran on that plane. Returns { planes, rows:[{benchmarkId, cells:{planeId->{identityHash,perf}}}] }.
export function buildCoverageMatrix(benchmarks) {
  const planes = [...new Set(benchmarks.flatMap((b) => b.planes.map((p) => p.planeId)))].sort();
  const rows = benchmarks.map((b) => {
    const cells = {};
    for (const p of b.planes) cells[p.planeId] = { identityHash: p.identityHash, performance: p.performance };
    return { benchmarkId: b.benchmarkId, filledPlanes: b.planes.map((p) => p.planeId).sort(), cells };
  });
  return { planes, rows };
}

// The empty (benchmarkId, planeId) cells -- the suite's frontier (next measurements to take), sorted stably.
export function frontierCells(benchmarks) {
  const planes = [...new Set(benchmarks.flatMap((b) => b.planes.map((p) => p.planeId)))].sort();
  const cells = [];
  for (const b of benchmarks) {
    const filled = new Set(b.planes.map((p) => p.planeId));
    for (const plane of planes) if (!filled.has(plane)) cells.push({ benchmarkId: b.benchmarkId, plane });
  }
  return cells.sort((a, c) => (a.benchmarkId + a.plane).localeCompare(c.benchmarkId + c.plane));
}

// Canonical verdict-bearing view (the digest input): schema + each benchmark's identity structure + the
// filled coverage cells + observatoryOk. Performance + plane profiles are reported but NOT sealed.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    benchmarks: (receipt.benchmarks || []).map((b) => ({
      benchmarkId: b.benchmarkId,
      planes: b.planes.map((p) => ({ planeId: p.planeId, identityHash: p.identityHash })),
      identityAgrees: b.identityAgrees,
      consensusHash: b.consensusHash,
    })),
    planesUnion: receipt.planesUnion,
    filledCells: (receipt.matrix?.rows || []).flatMap((r) => r.filledPlanes.map((p) => `${r.benchmarkId}@${p}`)).sort(),
    observatoryOk: receipt.verdict?.observatoryOk,
  });
}

export function digestObservatory(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Assemble the observatory from normalized benchmarks + optional plane profiles (os/hardware axis labels).
// observatoryOk iff NO benchmark's planes disagree on identity (no determinism violation) AND at least one
// benchmark is cross-plane-proven (>= 2 agreeing planes).
export function buildObservatory(benchmarks, { planeProfiles = {} } = {}) {
  const bs = (benchmarks || []).map(finalizeBenchmark).slice().sort((a, c) => a.benchmarkId.localeCompare(c.benchmarkId));
  const matrix = buildCoverageMatrix(bs);
  const frontier = frontierCells(bs);
  const crossPlaneProven = bs.filter((b) => b.identityAgrees === true);
  const violations = bs.filter((b) => b.identityAgrees === false);
  const pending = bs.filter((b) => b.identityAgrees === null);
  const filledCellCount = matrix.rows.reduce((n, r) => n + r.filledPlanes.length, 0);
  const totalCellCount = bs.length * matrix.planes.length;
  const observatoryOk = violations.length === 0 && crossPlaneProven.length >= 1;
  const receipt = {
    schema: OBSERVATORY_SCHEMA,
    benchmarks: bs,
    planesUnion: matrix.planes,
    planeProfiles,
    matrix,
    frontier,
    summary: {
      benchmarkTypeCount: bs.length,
      planeCount: matrix.planes.length,
      crossPlaneProvenCount: crossPlaneProven.length,
      pendingCount: pending.length,
      violationCount: violations.length,
      filledCellCount,
      totalCellCount,
      coveragePct: totalCellCount ? Math.round((filledCellCount / totalCellCount) * 1000) / 10 : 0,
      frontierCount: frontier.length,
    },
    verdict: {
      observatoryOk,
      reason: observatoryOk
        ? `${bs.length} benchmark type(s) across ${matrix.planes.length} plane(s); ${crossPlaneProven.length} cross-plane-proven, ${pending.length} pending, 0 violations; ${filledCellCount}/${totalCellCount} cells measured`
        : violations.length > 0
          ? `${violations.length} benchmark(s) DISAGREE on identity across planes (determinism violation): ${violations.map((b) => b.benchmarkId).join(', ')}`
          : 'no benchmark is cross-plane-proven (>= 2 agreeing planes) yet',
    },
  };
  receipt.digest = digestObservatory(receipt);
  return receipt;
}

// Validate an observatory receipt: re-derive each benchmark's agreement, the coverage matrix + frontier, the
// verdict, and the digest. Fail-closed -- a determinism violation, a matrix that contradicts the benchmarks,
// a forged verdict, or a tampered digest yields ok=false.
export function validateObservatory(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== OBSERVATORY_SCHEMA) findings.push(`schema must be ${OBSERVATORY_SCHEMA}`);
  if (!receipt || !Array.isArray(receipt.benchmarks) || !receipt.verdict || !receipt.matrix) {
    return { ok: false, observatoryOk: false, findings: findings.concat('missing benchmarks/matrix/verdict') };
  }
  let derivedViolations = 0;
  let derivedProven = 0;
  for (const b of receipt.benchmarks) {
    const { identityAgrees, consensusHash } = summarizeAgreement(b.planes || []);
    if (b.identityAgrees !== identityAgrees) findings.push(`benchmark ${b.benchmarkId} identityAgrees=${b.identityAgrees} contradicts its planes (${identityAgrees})`);
    if (b.consensusHash !== consensusHash) findings.push(`benchmark ${b.benchmarkId} consensusHash contradicts its planes`);
    if (identityAgrees === false) derivedViolations += 1;
    if (identityAgrees === true) derivedProven += 1;
  }
  // re-derive the coverage matrix from the benchmarks and confirm the receipt's matrix matches it
  const expectedMatrix = buildCoverageMatrix(receipt.benchmarks);
  if (JSON.stringify(expectedMatrix.planes) !== JSON.stringify(receipt.matrix.planes)) findings.push('coverage matrix planes contradict the benchmarks');
  const expectedFilled = expectedMatrix.rows.flatMap((r) => r.filledPlanes.map((p) => `${r.benchmarkId}@${p}`)).sort();
  const actualFilled = (receipt.matrix.rows || []).flatMap((r) => (r.filledPlanes || []).map((p) => `${r.benchmarkId}@${p}`)).sort();
  if (JSON.stringify(expectedFilled) !== JSON.stringify(actualFilled)) findings.push('coverage matrix filled cells contradict the benchmarks');
  const derivedOk = derivedViolations === 0 && derivedProven >= 1;
  if (receipt.verdict.observatoryOk !== derivedOk) findings.push(`verdict.observatoryOk=${receipt.verdict.observatoryOk} contradicts the benchmarks (${derivedOk})`);
  if (!derivedOk) findings.push('the observatory is not OK: a determinism violation or no cross-plane-proven benchmark');
  if (receipt.digest !== digestObservatory(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, observatoryOk: !!receipt.verdict.observatoryOk && findings.length === 0, findings };
}

const short = (h) => (h ? `${String(h).slice(0, 8)}...` : '--');
const perfOf = (cell) => (cell ? `${cell.performance.value ?? '--'}${cell.performance.unit}` : '');

// Render the observatory as the flagship Markdown surface (docs/benchmarks/benchmark-observatory.md). No
// markdown links (plane/paths are inline code) so it is Marketplace / link-check safe.
export function renderObservatoryMarkdown(receipt, { sources = [] } = {}) {
  const v = receipt.verdict;
  const s = receipt.summary;
  const prof = receipt.planeProfiles || {};
  const planeLabel = (p) => (prof[p] ? `\`${p}\`<br>${prof[p].os}/${prof[p].hardware}` : `\`${p}\``);
  const lines = [];
  lines.push('# Benchmark Observatory');
  lines.push('');
  lines.push('> GENERATED -- do not hand-edit. Regenerate with `node experiments/benchmark-observatory/generate-benchmark-observatory.mjs`; drift + determinism are gated by `benchmark-observatory`.');
  lines.push('');
  lines.push('The observatory is the suite-wide map above the cross-plane grid: it folds **every** committed benchmark receipt into one **benchmark-type x plane** coverage matrix, keeps the determinism ledger (does a benchmark reproduce its identity across the planes it ran on?), and exposes the empty cells as a data-driven **frontier**. Identity (`resultHash`) must **agree** across planes; performance is expected to differ.');
  lines.push('');
  lines.push(`**Observatory verdict: ${v.observatoryOk ? 'OK' : 'FAIL'}** -- ${s.benchmarkTypeCount} benchmark type(s) x ${s.planeCount} plane(s), ${s.filledCellCount}/${s.totalCellCount} cells measured (${s.coveragePct}%), ${s.crossPlaneProvenCount} cross-plane-proven, ${s.pendingCount} pending, ${s.violationCount} violation(s). ${v.reason}.`);
  lines.push('');
  lines.push('## Coverage matrix (benchmark type x plane)');
  lines.push('');
  lines.push(`| Benchmark \\ Plane | ${receipt.planesUnion.map(planeLabel).join(' | ')} | Planes |`);
  lines.push(`| --- | ${receipt.planesUnion.map(() => '---').join(' | ')} | --- |`);
  for (const row of receipt.matrix.rows) {
    const cells = receipt.planesUnion.map((p) => (row.cells[p] ? `OK ${perfOf(row.cells[p])}` : '.'));
    lines.push(`| ${row.benchmarkId} | ${cells.join(' | ')} | ${row.filledPlanes.length} |`);
  }
  lines.push('');
  lines.push('## Determinism ledger (cross-plane identity)');
  lines.push('');
  lines.push('| Benchmark | Planes | Consensus identity | Cross-plane? |');
  lines.push('| --- | --- | --- | --- |');
  for (const b of receipt.benchmarks) {
    const agree = b.identityAgrees === true ? `PROVEN (${b.planeCount}/${b.planeCount})`
      : b.identityAgrees === false ? 'NO -- VIOLATION'
        : `pending (${b.planeCount} plane)`;
    lines.push(`| ${b.title} | ${b.planes.map((p) => `\`${p.planeId}\``).join(', ')} | \`${short(b.consensusHash)}\` | ${agree} |`);
  }
  lines.push('');
  lines.push(`## Frontier -- ${receipt.frontier.length} unmeasured cell(s)`);
  lines.push('');
  lines.push('The next measurements that would extend the suite. Each is a (benchmark, plane) pair not yet run.');
  lines.push('');
  lines.push('| Benchmark | Plane (unmeasured) |');
  lines.push('| --- | --- |');
  for (const c of receipt.frontier) lines.push(`| ${c.benchmarkId} | \`${c.plane}\` |`);
  lines.push('');
  lines.push('## Sources (committed benchmark receipts)');
  lines.push('');
  for (const src of sources) lines.push(`- \`${src}\``);
  lines.push('');
  return lines.join('\n');
}
