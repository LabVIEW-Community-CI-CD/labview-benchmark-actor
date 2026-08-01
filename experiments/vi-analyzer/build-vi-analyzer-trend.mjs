#!/usr/bin/env node
// Build the VI Analyzer TREND receipt from a fetched guest run directory (run-vi-analyzer-trend.sh artifacts):
// parse each run's CLI completion block into the v2 normalized report (parse-vi-analyzer-ascii.mjs) and
// summarize it into a deterministic resultHash (viAnalyzerResult.mjs), then fold the per-run wall timings
// (trend-meta.jsonl) into a single trend receipt. The receipt's THESIS is DETERMINISM: a real compute workload
// (VI Analyzer over the same VIs) run N times must yield the SAME resultHash every time -- and that digest must
// match the single-run cross-plane canonical. Wall timings additionally expose the cold(run 1: LabVIEW launch)
// vs warm(runs 2..N: resident analyze) profile.
//
// Usage:  node experiments/vi-analyzer/build-vi-analyzer-trend.mjs <fetch-dir> > vi-analyzer-trend-live-evidence.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseAsciiReport } from './parse-vi-analyzer-ascii.mjs';
import { summarizeViAnalyzerReport } from './viAnalyzerResult.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || '/tmp/via-trend-fetch';
const CONFIG = 'LabVIEWCLIExampleProject';
// The established single-run cross-plane canonical (experiments/vi-analyzer/vi-analyzer-live-evidence.json).
const CANONICAL_HASH = '0419a44941941102b5289f8a2e37ad59756d84edaa961dedb9258d3ccf7d3c12';

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const meta = readFileSync(join(dir, 'trend-meta.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));

const runs = meta.map((m) => {
  const cli = readFileSync(join(dir, m.cli), 'utf8');
  const report = parseAsciiReport(cli, CONFIG); // completion block -> { summary, findings:[] } for an all-pass run
  const s = summarizeViAnalyzerReport(report);
  return {
    run: m.run,
    wallMs: m.wallMs,
    exit: m.exit,
    totalTests: s.totalTests,
    summary: { passed: s.passedTests, failed: s.failedTests, error: s.errorTests, skipped: s.skippedTests, unloadable: s.unloadableTests },
    resultHash: s.resultHash,
  };
});

const hashes = [...new Set(runs.map((r) => r.resultHash))];
const deterministic = hashes.length === 1;
const matchesCanonical = deterministic && hashes[0] === CANONICAL_HASH;
const allPass = runs.every((r) => r.exit === 0 && r.summary.passed === 69 && r.summary.failed === 0 && r.summary.error === 0);

const coldWallMs = runs[0].wallMs;
const warmWallMs = runs.slice(1).map((r) => r.wallMs);
const warmMedianMs = median(warmWallMs);

// Per-plane metadata: the SAME LabVIEWCLIExampleProject config runs on both substrates so the resultHash must
// match; only the host substrate (OS + LabVIEW build + display model) differs.
const plane = (process.env.LBA_PLANE || 'LINUX').toUpperCase();
const PLANE_META = {
  LINUX: {
    vm: 'lba-ubuntu2404-labview2026-scratch',
    labview: 'LabVIEW 2026 Q1 Community 64-bit (activated)',
    display: 'headless Xvfb :99 (xdpyinfo-gated readiness)',
    harness: 'experiments/vi-analyzer/run-vi-analyzer-trend.sh (guest-resident; explicit PATH survives a detached shell)',
    note: 'run 1 cold-launches LabVIEW; runs 2..N connect to the resident LabVIEW (VI Server 3363) -> warm analyze',
  },
  WIN: {
    vm: 'actor-win11-decouple',
    labview: 'LabVIEW 2026 32-bit (licensed)',
    display: 'interactive Windows desktop (no Xvfb; LabVIEW needs a window station)',
    harness: 'experiments/vi-analyzer/run-vi-analyzer-trend.ps1 (operator-run; the SAME LabVIEWCLIExampleProject shipped via the VM share)',
    note: 'run 1 cold-launches LabVIEW (Windows first-launch mass-compile, very cold); runs 2..N warm',
  },
};
const pm = PLANE_META[plane] || PLANE_META.LINUX;

const receipt = {
  schema: 'labview-benchmark-actor/vi-analyzer-trend-live-evidence@1',
  capturedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  operatorPrompt: `Go. windows cleanroom has a labview license (VI Analyzer TREND, ${plane} plane)`,
  cleanroom: {
    vm: pm.vm,
    plane,
    hypervisor: 'virtualbox',
    labview: pm.labview,
    viAnalyzerToolkit: 'installed',
  },
  workload: {
    type: 'vi-analyzer-trend',
    operation: 'LabVIEWCLI -OperationName RunVIAnalyzer',
    display: pm.display,
    config: 'NI LabVIEWCLIExampleProject/ConfigFile.viancfg',
    target: '3 VIs (Add.vi, Increment.vi, Decrement.vi) -> 69 tests',
    runs: runs.length,
    harness: pm.harness,
    note: pm.note,
  },
  runs,
  trend: {
    wallMs: runs.map((r) => r.wallMs),
    coldWallMs,
    warmMedianMs,
    warmMinMs: Math.min(...warmWallMs),
    warmMaxMs: Math.max(...warmWallMs),
    coldOverWarm: +(coldWallMs / warmMedianMs).toFixed(2),
    note: 'wall ms per LabVIEWCLI RunVIAnalyzer invocation; warm runs are analyze-dominated (LabVIEW resident)',
  },
  determinism: {
    distinctResultHashes: hashes.length,
    resultHash: hashes[0],
    deterministicAcrossRuns: deterministic,
    matchesSingleRunCanonical: matchesCanonical,
    canonicalHash: CANONICAL_HASH,
  },
  gate: {
    by: 'agent (deterministic)',
    method: 'run-vi-analyzer-trend.sh (guest) -> parse-vi-analyzer-ascii.mjs -> viAnalyzerResult.mjs per run',
    verdict:
      deterministic && matchesCanonical && allPass
        ? `PASS -- ${runs.length}/${runs.length} runs 69/69 all-pass; ONE resultHash across all runs, matching the single-run canonical (determinism proven)`
        : 'FAIL -- see determinism/allPass flags',
    note: 'a compute workload: the deterministic result digest repeated across runs is the gate, not a screenshot',
  },
};

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!(deterministic && matchesCanonical && allPass)) {
  process.stderr.write('TREND GATE FAILED\n');
  process.exit(1);
}
