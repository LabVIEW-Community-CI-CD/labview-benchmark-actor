#!/usr/bin/env node
// Generate docs/benchmarks/benchmark-grid.md (LBA-REQ-050) from the committed cross-plane benchmark receipts.
// Mirrors the traceability-matrix / test-report generators: run with no args to WRITE the surface; run with
// `--check` to fail closed (exit 3) if the committed surface has drifted. Wired into the `lba verify`
// pipeline so the grid regenerates on every run. Pure + offline -- derives the grid from committed receipts,
// no LabVIEW / VM / ripgrep.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  benchmarkFromViAnalyzerComparison, benchmarkFromMassCompileReceipts,
  buildBenchmarkGrid, validateBenchmarkGrid, renderBenchmarkGridMarkdown,
} from './benchmarkGrid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const OUT_REL = 'docs/benchmarks/benchmark-grid.md';

const SOURCES = {
  viAnalyzer: 'experiments/vi-analyzer/fixtures/cross-plane-comparison-receipt.json',
  massCompileGolden: 'experiments/mass-compile/fixtures/mass-compile-benchmark-receipt.json',
  massCompileHost: 'experiments/benchmark-grid/fixtures/mass-compile-host.receipt.json',
  massCompileWin: 'experiments/benchmark-grid/fixtures/mass-compile-win.receipt.json',
};
const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

// Build the grid from the committed receipts (exported so the self-test derives the identical grid).
export function buildGridFromCommittedReceipts() {
  const viAnalyzer = benchmarkFromViAnalyzerComparison(readJson(SOURCES.viAnalyzer));
  const massCompile = benchmarkFromMassCompileReceipts([
    readJson(SOURCES.massCompileGolden),
    readJson(SOURCES.massCompileHost),
    readJson(SOURCES.massCompileWin),
  ]);
  return buildBenchmarkGrid([viAnalyzer, massCompile]);
}

export function renderCommittedGrid() {
  return renderBenchmarkGridMarkdown(buildGridFromCommittedReceipts(), {
    sources: [SOURCES.viAnalyzer, SOURCES.massCompileGolden, SOURCES.massCompileHost, SOURCES.massCompileWin],
  });
}

function main() {
  const grid = buildGridFromCommittedReceipts();
  const v = validateBenchmarkGrid(grid);
  if (!v.ok) {
    console.error(`benchmark-grid: the derived grid is INVALID -- ${v.findings.join('; ')}`);
    process.exit(2);
  }
  const rendered = renderCommittedGrid();
  const outPath = join(repoRoot, OUT_REL);
  if (process.argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing */ }
    if (current !== rendered) {
      console.error(`benchmark-grid: DRIFT -- ${OUT_REL} is stale. Regenerate with: node experiments/benchmark-grid/generate-benchmark-grid.mjs`);
      process.exit(3);
    }
    console.log(`benchmark-grid: ${OUT_REL} is current (grid OK, ${grid.summary.crossPlaneProvenCount}/${grid.summary.benchmarkCount} cross-plane-proven).`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered);
  console.log(`benchmark-grid: wrote ${OUT_REL} (grid ${grid.verdict.gridOk ? 'OK' : 'FAIL'}, ${grid.summary.crossPlaneProvenCount}/${grid.summary.benchmarkCount} cross-plane-proven across ${grid.summary.planeCount} planes).`);
}

// Only run when invoked directly (so the self-test can import the builders without triggering a write).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
