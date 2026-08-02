#!/usr/bin/env node
// Generate docs/benchmarks/benchmark-observatory.md (LBA-REQ-054) from every committed benchmark receipt.
// Mirrors the benchmark-grid / traceability-matrix / test-report generators: run with no args to WRITE the
// surface; run with `--check` to fail closed (exit 3) if the committed surface has drifted. Wired into the
// `lba verify` pipeline so the observatory regenerates on every run. Pure + offline -- derives from committed
// receipts, no LabVIEW / VM / container / ripgrep.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  benchmarkFromViAnalyzerComparison, benchmarkFromMassCompileReceipts,
  benchmarkFromPplBuild, benchmarkFromLunitTest,
  buildObservatory, validateObservatory, renderObservatoryMarkdown,
} from './benchmarkObservatory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const OUT_REL = 'docs/benchmarks/benchmark-observatory.md';

const SOURCES = {
  viAnalyzer: 'experiments/vi-analyzer/fixtures/cross-plane-comparison-receipt.json',
  massCompileGolden: 'experiments/mass-compile/fixtures/mass-compile-benchmark-receipt.json',
  massCompileHost: 'experiments/benchmark-grid/fixtures/mass-compile-host.receipt.json',
  massCompileWin: 'experiments/benchmark-grid/fixtures/mass-compile-win.receipt.json',
  pplBuild: 'experiments/ppl-build/fixtures/ppl-build-benchmark-receipt.json',
  lunitTest: 'experiments/lunit-test/fixtures/lunit-test-benchmark-receipt.json',
};

// OS x hardware axis labels for the planes (descriptive -- rendered in the matrix header, not sealed).
const PLANE_PROFILES = {
  host: { os: 'linux', hardware: 'bare-metal' },
  'lba-golden': { os: 'linux', hardware: 'vm' },
  'linux-container': { os: 'linux', hardware: 'container' },
  'vm:lba-ubuntu2404-labview2026-scratch': { os: 'linux', hardware: 'vm' },
  'win-VITLT-SERGIO': { os: 'windows', hardware: 'physical' },
};

const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

// Build the observatory from every committed receipt (exported so the self-test derives the identical map).
export function buildObservatoryFromCommittedReceipts() {
  const benchmarks = [
    benchmarkFromViAnalyzerComparison(readJson(SOURCES.viAnalyzer)),
    benchmarkFromMassCompileReceipts([
      readJson(SOURCES.massCompileGolden), readJson(SOURCES.massCompileHost), readJson(SOURCES.massCompileWin),
    ]),
    benchmarkFromPplBuild(readJson(SOURCES.pplBuild)),
    benchmarkFromLunitTest(readJson(SOURCES.lunitTest)),
  ];
  return buildObservatory(benchmarks, { planeProfiles: PLANE_PROFILES });
}

export function renderCommittedObservatory() {
  return renderObservatoryMarkdown(buildObservatoryFromCommittedReceipts(), { sources: Object.values(SOURCES) });
}

function main() {
  const obs = buildObservatoryFromCommittedReceipts();
  const v = validateObservatory(obs);
  if (!v.ok) {
    console.error(`benchmark-observatory: the derived observatory is INVALID -- ${v.findings.join('; ')}`);
    process.exit(2);
  }
  const rendered = renderCommittedObservatory();
  const outPath = join(repoRoot, OUT_REL);
  if (process.argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing */ }
    if (current !== rendered) {
      console.error(`benchmark-observatory: DRIFT -- ${OUT_REL} is stale. Regenerate with: node experiments/benchmark-observatory/generate-benchmark-observatory.mjs`);
      process.exit(3);
    }
    console.log(`benchmark-observatory: ${OUT_REL} is current (observatory OK, ${obs.summary.crossPlaneProvenCount}/${obs.summary.benchmarkTypeCount} cross-plane-proven, ${obs.summary.coveragePct}% cells).`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered);
  console.log(`benchmark-observatory: wrote ${OUT_REL} (observatory ${obs.verdict.observatoryOk ? 'OK' : 'FAIL'}, ${obs.summary.benchmarkTypeCount} types x ${obs.summary.planeCount} planes, ${obs.summary.coveragePct}% cells, ${obs.summary.frontierCount} frontier).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
